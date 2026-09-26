"use server";

import type { SQL } from "drizzle-orm";
import type { DriveAccessOptions, DriveContext, DriveTransaction } from "@/lib/drive-access";
import type { DriveRow } from "@/lib/drive-schema";
import type { ActionResult, DriveArchiveManifest, DriveItem, DriveListInput, DriveListing, DriveRestoreResult, EmptyTrashResult, TrashSummary, UploadResolution, UploadTicket } from "@/lib/drive-types";
import { randomUUID } from "node:crypto";
// Aliased: `after` is also the listing's "modified after" date filter.
import { after as afterResponse } from "next/server";
import { and, arrayContains, asc, desc, eq, getTableColumns, gte, ilike, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { assertItemAccess, assertItemsAccess, canAccessPublic, driveAction, getItemAccess, getListingAccess, visibleItemsCondition, withDriveTransaction } from "@/lib/drive-access";
import { discoverableRootsCondition } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { driveFavorites, driveItems } from "@/lib/drive-schema";
import { assertMoveDepth, childFirst, folderPath, loadTree, MAX_FOLDER_DEPTH, selectedRows } from "@/lib/drive-tree";
import { MAX_UPLOAD_BYTES } from "@/lib/drive-types";
import { copyFileObject, createObjectKey, createPublicToken, publicShareUrl, removeObject, signDownload, toDriveItem } from "@/lib/storage";
import { cancelTrashedUploads, emptyDriveTrash, permanentlyDeleteDriveItems, restoreDriveItems, trashDriveItems, trashRows, trashSummary } from "@/lib/trash";
import { recordEvents } from "@/lib/activity";
import { queueScanSubmission } from "@/lib/virus-scan-jobs";
import { SIGNAL_LABELS, type FileRiskSignal } from "@/lib/file-risk-signals";
import { prioritizeScans } from "@/lib/file-risk";
import { driveFileRisks, driveVirusScans } from "@/lib/virustotal-schema";
import { itemType } from "@/lib/item-type";
import { assertCapability, defaultItemAccess } from "@/lib/drive-access";
import type { DriveTree } from "@/lib/drive-tree";
import type { ConflictResolutions, DriveCopyResult, DriveMoveResult } from "@/lib/drive-types";
import { assertQuota } from "@/lib/quota";
import { conflictResolutionsSchema, destinationSiblings } from "@/lib/name-conflicts";
import { planTransfer } from "@/lib/transfer-plan";
import { idSchema, mimeSchema, nameSchema, parentSchema, uploadKeySchema, uploadResolutionSchema } from "@/lib/drive-input";
import { cancelPendingUpload, finishUpload, startUpload } from "@/lib/uploads";
import { enqueueSearch, enqueueSearchTree, removeFromSearch } from "@/lib/search-index";
import { assertMutationGuard, completeMutationGuard } from "@/lib/drive-mutation-guard";

/** Files assessed per listing in the background, so older files get risk scores without a batch job. */
const RISK_BACKFILL_PER_LISTING = 10;

const idsSchema = z.array(idSchema).min(1, "Choose at least one file or folder.").max(1000, "Choose up to 1,000 items at a time.").transform((ids) => [...new Set(ids)]);

async function itemData(tx: DriveTransaction, ctx: DriveContext, row: DriveRow): Promise<DriveItem> {
  return { ...toDriveItem(row), ...await getItemAccess(tx, ctx, row) };
}

async function requireItem(tx: DriveTransaction, ctx: DriveContext, id: string, permission: DriveAccessOptions["permission"] = "read"): Promise<DriveRow> {
  const [row] = await tx.select().from(driveItems).where(and(eq(driveItems.id, id), eq(driveItems.state, "complete")));
  if (!row) throw new DriveError("This file or folder is no longer available.");
  await assertItemAccess(tx, ctx, row, { permission });
  return row;
}

async function destination(tx: DriveTransaction, ctx: DriveContext, parentId: string | null, addingFolder = false): Promise<DriveRow[]> {
  const path = await folderPath(tx, parentId);
  if (path.length) await assertItemAccess(tx, ctx, path[path.length - 1], { permission: "write" });
  else await assertItemsAccess(tx, ctx, [], { permission: "write" });
  if (addingFolder && path.length >= MAX_FOLDER_DEPTH) throw new DriveError("Folders can be nested up to 64 levels deep.");
  return path;
}

export async function listDrive(input: DriveListInput = {}): Promise<ActionResult<DriveListing>> {
  return driveAction(async (ctx) => {
    const parsed = z.object({
      folderId: parentSchema,
      filter: z.enum(["all", "public", "recent", "trash", "favorites"]).default("all"),
      search: z.string().trim().max(200, "Search must be 200 characters or fewer.").default(""),
      type: z.enum(["all", "folder", "image", "video", "audio", "pdf", "text", "code", "archive", "other"]).default("all"),
      minSize: z.number().int().min(0).optional(),
      maxSize: z.number().int().min(0).optional(),
      after: z.iso.date().optional(),
      before: z.iso.date().optional(),
      sort: z.enum(["name", "updatedAt", "size", "type"]).optional(),
      direction: z.enum(["asc", "desc"]).optional(),
      foldersOnly: z.boolean().default(false),
      tags: z.array(z.string().max(64)).max(20).optional(),
    }).refine((value) => value.minSize === undefined || value.maxSize === undefined || value.minSize <= value.maxSize, "Minimum size must not exceed maximum size.")
      .refine((value) => !value.after || !value.before || value.after <= value.before, "The start date must not be after the end date.").parse(input);
    return withDriveTransaction("read", async (tx) => {
      const { folderId, filter, search, type, minSize, maxSize, after, before, foldersOnly, tags } = parsed;
      const trash = filter === "trash" && !foldersOnly;
      const isFavorite = sql<boolean>`exists (select 1 from ${driveFavorites}
        where ${driveFavorites.itemId} = ${driveItems.id} and ${driveFavorites.userId} = ${ctx.userId})`;
      // Load the whole path once, keeping the same cycle/depth and folder checks
      // as folderPath without one network roundtrip per ancestor.
      const ancestors = folderId ? await tx.select({ ...getTableColumns(driveItems), isFavorite }).from(driveItems).where(sql`${driveItems.id} in (
        with recursive path as (
          select id, parent_id from drive_items where id = ${folderId}::uuid
          union
          select parent.id, parent.parent_id from drive_items parent join path child on child.parent_id = parent.id
        ) select id from path
      )`) : [];
      const ancestorsById = new Map(ancestors.map((row) => [row.id, row]));
      const path: typeof ancestors = [];
      const seen = new Set<string>();
      let cursor = folderId?.toLowerCase() ?? null;
      while (cursor) {
        if (seen.has(cursor) || path.length >= MAX_FOLDER_DEPTH) throw new DriveError("Folders can be nested up to 64 levels deep.");
        seen.add(cursor);
        const folder = ancestorsById.get(cursor);
        if (!folder || folder.kind !== "folder" || folder.state !== "complete") throw new DriveError("The destination folder is no longer available.");
        path.push(folder);
        cursor = folder.parentId;
      }
      path.reverse();
      const current = path.at(-1);
      const global = !foldersOnly && Boolean(search || type !== "all" || minSize !== undefined || maxSize !== undefined || after || before || tags?.length);
      const conditions: SQL[] = [eq(driveItems.state, "complete"), visibleItemsCondition(ctx, { trash })];
      // Rows being permanently deleted leave Trash immediately; their removal finishes in the background.
      conditions.push(trash ? and(isNotNull(driveItems.trashedAt), isNull(driveItems.deletionStartedAt))! : isNull(driveItems.trashedAt));
      if (foldersOnly) conditions.push(eq(driveItems.kind, "folder"));
      else if (filter === "public") conditions.push(isNotNull(driveItems.publicToken), sql`(${driveItems.publicExpiresAt} is null or ${driveItems.publicExpiresAt} > clock_timestamp())`);
      else if (filter === "recent") conditions.push(eq(driveItems.kind, "file"), sql`exists (select 1 from drive_activity where drive_activity.item_id = ${driveItems.id} and drive_activity.user_id = ${ctx.userId})`);
      else if (filter === "favorites") conditions.push(sql`exists (select 1 from drive_favorites where drive_favorites.item_id = ${driveItems.id} and drive_favorites.user_id = ${ctx.userId})`);
      if (search) conditions.push(ilike(driveItems.name, `%${search.replace(/[\\%_]/g, "\\$&")}%`));
      if (!foldersOnly && type !== "all") conditions.push(sql`${itemType} = ${type}`);
      if (minSize !== undefined) conditions.push(gte(driveItems.size, minSize));
      if (maxSize !== undefined) conditions.push(lte(driveItems.size, maxSize));
      if (after) conditions.push(gte(driveItems.updatedAt, new Date(`${after}T00:00:00.000Z`)));
      if (before) conditions.push(lt(driveItems.updatedAt, new Date(new Date(`${before}T00:00:00.000Z`).getTime() + 86_400_000)));
      if (tags?.length) {
        const wanted = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
        if (wanted.length) conditions.push(arrayContains(driveItems.tags, wanted));
      }
      if (!global && (foldersOnly || filter === "all" || trash)) {
        if (folderId) conditions.push(eq(driveItems.parentId, folderId));
        else if (trash) conditions.push(sql`(${discoverableRootsCondition(ctx, { trash })} or not exists (
          select 1 from drive_items parent where parent.id = ${driveItems.parentId}
          and parent.trashed_at is not null and parent.trash_root_id is not distinct from ${driveItems.trashRootId}
        ))`);
        else conditions.push(discoverableRootsCondition(ctx));
      }
      const sort = parsed.sort ?? (filter === "recent" ? "updatedAt" : "name");
      const direction = parsed.direction ?? (filter === "recent" ? "desc" : "asc");
      const order = direction === "asc" ? asc : desc;
      const recentActivityColumn = sql`(select accessed_at from drive_activity where item_id = ${driveItems.id} and user_id = ${ctx.userId})`;
      const sortColumn = filter === "recent" && parsed.sort === undefined ? recentActivityColumn
        : sort === "name" ? sql`lower(${driveItems.name})` : sort === "updatedAt" ? driveItems.updatedAt : sort === "size" ? driveItems.size : itemType;
      const ordering = sort === "name" ? [desc(driveItems.kind), order(sortColumn), asc(driveItems.id)] : [order(sortColumn), asc(sql`lower(${driveItems.name})`), asc(driveItems.id)];
      const query = tx.select({
        item: driveItems,
        isFavorite,
        scanStatus: driveVirusScans.status,
        riskLevel: driveFileRisks.level,
        riskSignals: driveFileRisks.signals,
      }).from(driveItems)
        .leftJoin(driveVirusScans, and(eq(driveItems.kind, "file"), eq(driveVirusScans.itemId, driveItems.id)))
        .leftJoin(driveFileRisks, and(eq(driveItems.kind, "file"), eq(driveFileRisks.itemId, driveItems.id)))
        .where(and(...conditions)).orderBy(...ordering);
      const listed = filter === "recent" && !global ? await query.limit(100) : await query;
      // Authorization is evaluated before returning any row, breadcrumb, or
      // background work, with one fresh ancestor snapshot shared by the listing.
      const { access, breadcrumbs } = await getListingAccess(tx, ctx, listed.map(({ item }) => item), path, trash);
      // Never assessed: score them after this response. Protected folders stay private, even their file names.
      const unassessed = listed.filter(({ item, riskLevel }) => item.kind === "file" && riskLevel === null && !access.get(item.id)!.isProtected).slice(0, RISK_BACKFILL_PER_LISTING).map(({ item }) => item.id);
      if (unassessed.length) afterResponse(() => prioritizeScans(unassessed));
      return {
        items: listed.map(({ item, isFavorite, scanStatus: status, riskLevel, riskSignals }) => {
          const scanStatus = status === "pending" ? "scanning" as const : status === "clean" || status === "suspicious" || status === "malicious" ? status : undefined;
          // Suggest a scan only while there's no result to show instead.
          const scanSuggestion = !scanStatus && (riskLevel === "medium" || riskLevel === "high")
            ? { level: riskLevel, reasons: (riskSignals ?? []).flatMap((signal) => SIGNAL_LABELS[signal as FileRiskSignal] ?? []) }
            : undefined;
          return { ...toDriveItem(item), ...access.get(item.id)!, isFavorite, scanStatus, scanSuggestion };
        }),
        breadcrumbs,
        currentFolder: current ? { ...toDriveItem(current), ...access.get(current.id)!, isFavorite: current.isFavorite } : null,
      };
    });
  }, "read");
}

export async function createFolder(input: { name: string; parentId?: string | null }): Promise<ActionResult<DriveItem>> {
  return driveAction(async (ctx) => {
    const { name, parentId } = z.object({ name: nameSchema, parentId: parentSchema }).parse(input);
    return withDriveTransaction("write", async (tx) => {
      await destination(tx, ctx, parentId, true);
      await assertMutationGuard(tx, ctx, { operation: "create_folder", name, parentId });
      const [folder] = await tx.insert(driveItems).values({ id: randomUUID(), name, parentId, kind: "folder", state: "complete", size: 0, createdBy: ctx.userId, ...defaultItemAccess(ctx, parentId) }).returning();
      await recordEvents(tx, ctx, [{ action: "create_folder", item: { id: folder.id, name, kind: "folder", parentId } }]);
      await completeMutationGuard(tx, ctx, { itemIds: [folder.id], names: [folder.name] });
      return itemData(tx, ctx, folder);
    });
  });
}

/**
 * Starts an upload. When the name is taken the result lists the conflict (id = `key`, or the name); retry with
 * `resolution`: "replace" makes the upload a new version of a same-named file (anything else goes to Trash),
 * "keep-both" uploads under a numbered name.
 */
export async function beginUpload(input: { name: string; size: number; mimeType: string; parentId?: string | null; key?: string; resolution?: UploadResolution }): Promise<ActionResult<UploadTicket>> {
  return driveAction(async (ctx) => {
    const { name, size, mimeType, parentId, key, resolution } = z.object({
      name: nameSchema, size: z.number().int().min(0).max(MAX_UPLOAD_BYTES, "Files must be 5 GiB or smaller."), mimeType: mimeSchema, parentId: parentSchema,
      key: uploadKeySchema.optional(), resolution: uploadResolutionSchema.optional(),
    }).parse(input);
    return startUpload(ctx, { key: key ?? name, name, size, mimeType, parentId, resolution });
  });
}

export async function completeUpload(id: string): Promise<ActionResult<DriveItem>> {
  return driveAction(async (ctx) => finishUpload(ctx, idSchema.parse(id)));
}

export async function cancelUpload(id: string): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => cancelPendingUpload(ctx, idSchema.parse(id)));
}

export async function renameItem(input: { id: string; name: string }): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    const { id, name } = z.object({ id: idSchema, name: nameSchema }).parse(input);
    await withDriveTransaction("write", async (tx) => {
      const row = await requireItem(tx, ctx, id, "write");
      await assertMutationGuard(tx, ctx, { operation: "rename_item", itemId: id, name });
      await tx.update(driveItems).set({ name, updatedAt: new Date() }).where(eq(driveItems.id, id));
      if (row.name !== name) await recordEvents(tx, ctx, [{ action: "rename", item: { id, name, kind: row.kind, parentId: row.parentId }, details: { fromName: row.name } }]);
      // A file's name leads its first passage; folder names are never embedded.
      if (row.name !== name && row.kind === "file") await enqueueSearch(tx, [id]);
      await completeMutationGuard(tx, ctx, { itemIds: [id], names: [name] });
    });
  });
}

/**
 * Replace: checks that the destination items chosen for replacing may go to Trash. Needs the trash
 * capability (an MCP connection without Trash access can't replace), and never trashes a folder that
 * holds something being moved or copied, which would take the source (or its parent) with it.
 */
async function assertReplaceable(tx: DriveTransaction, ctx: DriveContext, replaceIds: string[], incoming: DriveTree): Promise<void> {
  if (!replaceIds.length) return;
  assertCapability("trash");
  const replaced = await loadTree(tx, replaceIds);
  await assertItemsAccess(tx, ctx, replaced.rows, { allowTrashed: true, permission: "write" });
  if (replaced.rows.some((row) => incoming.byId.has(row.id))) throw new DriveError("A folder can’t be replaced by something that’s inside it. Choose Keep both or Skip for it.");
}

export async function moveItems(input: { ids: string[]; parentId: string | null; resolutions?: ConflictResolutions }): Promise<ActionResult<DriveMoveResult>> {
  return driveAction(async (ctx) => {
    const { ids, parentId, resolutions } = z.object({ ids: idsSchema, parentId: parentSchema, resolutions: conflictResolutionsSchema }).parse(input);
    const { result, pendingIds } = await withDriveTransaction("write", async (tx) => {
      const selected = await selectedRows(tx, ids);
      if (selected.some((row) => row.state !== "complete" || row.trashedAt)) throw new DriveError("Only available files and folders can be moved.");
      const tree = await loadTree(tx, ids);
      await assertItemsAccess(tx, ctx, tree.rows, { allowTrashed: true, permission: "write" });
      await assertItemsAccess(tx, ctx, selected, { permission: "write" });
      const path = await destination(tx, ctx, parentId);
      assertMoveDepth(tree, path);
      await assertMutationGuard(tx, ctx, { operation: "move_items", itemIds: ids, parentId });
      const plan = planTransfer(tree.roots, await destinationSiblings(tx, ctx, parentId), resolutions, "move", parentId);
      await assertReplaceable(tx, ctx, plan.replaceIds, tree);
      const pendingIds = plan.replaceIds.length ? await trashRows(tx, ctx, plan.replaceIds, { reason: "replaced" }) : [];
      if (path.some((folder) => Boolean(folder.passwordHash))) {
        await tx.update(driveItems).set({ publicToken: null, publicExpiresAt: null, sharedByEmail: null }).where(inArray(driveItems.id, tree.rows.map((row) => row.id)));
      }
      // Landing under a protected or excluded folder drops the passages now; leaving one brings them back.
      const hidden = path.some((folder) => folder.passwordHash) ? "protected" : path.some((folder) => folder.searchExcluded) ? "excluded" : null;
      if (hidden) await removeFromSearch(tx, plan.items.map(({ root }) => root.id), hidden);
      else await enqueueSearchTree(tx, plan.items.map(({ root }) => root.id));
      const now = new Date();
      const keepingName = plan.items.filter(({ root, name }) => name === root.name).map(({ root }) => root.id);
      if (keepingName.length) await tx.update(driveItems).set({ parentId, updatedAt: now }).where(inArray(driveItems.id, keepingName));
      const renamed = plan.items.filter(({ root, name }) => name !== root.name);
      for (const { root, name } of renamed) await tx.update(driveItems).set({ parentId, name, updatedAt: now }).where(eq(driveItems.id, root.id));
      if (!hidden) await enqueueSearch(tx, renamed.filter(({ root }) => root.kind === "file").map(({ root }) => root.id));
      const fromIds = [...new Set(plan.items.flatMap(({ root }) => root.parentId ?? []))];
      const fromNames = new Map(fromIds.length ? (await tx.select({ id: driveItems.id, name: driveItems.name }).from(driveItems)
        .where(and(inArray(driveItems.id, fromIds), visibleItemsCondition(ctx)))).map((row) => [row.id, row.name]) : []);
      const toParentName = path.at(-1)?.name ?? null;
      await recordEvents(tx, ctx, plan.items.map(({ root, name }) => ({
        action: "move", item: { id: root.id, name, kind: root.kind, parentId },
        details: { fromParentId: root.parentId && fromNames.has(root.parentId) ? root.parentId : null, fromParentName: root.parentId ? fromNames.get(root.parentId) ?? null : null, toParentName, ...(name !== root.name ? { renamedFrom: root.name } : {}) },
      })));
      await completeMutationGuard(tx, ctx, { itemIds: plan.items.map(({ root }) => root.id), names: plan.items.map(({ name }) => name) });
      return {
        result: {
          moved: plan.items.map(({ root }) => ({ id: root.id, fromParentId: root.parentId && fromNames.has(root.parentId) ? root.parentId : null })),
          renamed: renamed.map(({ root }) => ({ id: root.id, fromName: root.name })),
          replacedIds: plan.replaceIds,
        },
        pendingIds,
      };
    });
    await cancelTrashedUploads(pendingIds);
    return result;
  });
}

const MAX_COPY_ITEMS = 2_000;

/**
 * Copies files and folders (with everything inside) into a folder. R2 duplicates the bytes server-side
 * before any row exists, so a failure part-way leaves nothing behind: copied objects are removed and
 * no row is written. Public links, favorites and scan results are not copied. Name collisions are
 * planned (and asked about) before any bytes are copied, then planned again in the final transaction.
 */
export async function copyItems(input: { ids: string[]; parentId: string | null; resolutions?: ConflictResolutions }): Promise<ActionResult<DriveCopyResult>> {
  return driveAction(async (ctx) => {
    const { ids, parentId, resolutions } = z.object({ ids: idsSchema, parentId: parentSchema, resolutions: conflictResolutionsSchema }).parse(input);
    const { tree, plan } = await withDriveTransaction("read", async (tx) => {
      const selected = await selectedRows(tx, ids);
      if (selected.some((row) => row.state !== "complete" || row.trashedAt)) throw new DriveError("Only available files and folders can be copied.");
      const tree = await loadTree(tx, ids);
      await assertItemsAccess(tx, ctx, tree.rows, { allowTrashed: true });
      const path = await destination(tx, ctx, parentId);
      if (path.some((folder) => tree.byId.has(folder.id))) throw new DriveError("A folder can’t be copied into itself or one of its subfolders.");
      assertMoveDepth(tree, path);
      const plan = planTransfer(tree.roots, await destinationSiblings(tx, ctx, parentId), resolutions, "copy", parentId);
      await assertReplaceable(tx, ctx, plan.replaceIds, tree);
      return { tree, plan };
    });

    // Parents before children; skip anything trashed or unfinished, and everything under it.
    const rootNames = new Map(plan.items.map(({ root, name }) => [root.id, name]));
    const newIds = new Map<string, string>();
    const rows: { source: DriveRow; copy: typeof driveItems.$inferInsert }[] = [];
    for (const source of childFirst(tree.rows).reverse()) {
      const rootName = rootNames.get(source.id);
      if (source.state !== "complete" || source.trashedAt || (rootName === undefined && !newIds.has(source.parentId ?? ""))) continue;
      const id = randomUUID();
      newIds.set(source.id, id);
      rows.push({
        source,
        copy: {
          id, name: rootName ?? source.name, kind: source.kind, parentId: rootName === undefined ? newIds.get(source.parentId!)! : parentId,
          description: source.description, tags: source.tags, folderColor: source.folderColor, folderEmoji: source.folderEmoji, state: "complete", createdBy: ctx.userId,
          ...defaultItemAccess(ctx, rootName === undefined ? newIds.get(source.parentId!)! : parentId),
          ...(source.kind === "file"
            ? { size: source.size, mimeType: source.mimeType, objectKey: createObjectKey(id) }
            // A copied protected folder stays protected, under a fresh version so earlier unlocks don't carry over.
            : { passwordHash: source.passwordHash, passwordVersion: source.passwordHash ? randomUUID() : null, searchExcluded: source.searchExcluded }),
        },
      });
    }
    if (rows.length > MAX_COPY_ITEMS) throw new DriveError(`Copies are limited to ${MAX_COPY_ITEMS.toLocaleString("en")} items at a time.`);
    const files = rows.filter(({ source }) => source.kind === "file");
    const totalBytes = files.reduce((sum, { source }) => sum + source.size, 0);
    // Checked before copying so a copy that can't fit doesn't duplicate gigabytes first; the check in the write transaction is the one that counts.
    await withDriveTransaction("read", (tx) => assertQuota(tx, ctx, totalBytes));

    const copied: DriveRow[] = [];
    let pendingIds: string[] = [];
    try {
      for (let index = 0; index < files.length; index += 4) {
        await Promise.all(files.slice(index, index + 4).map(async (file) => {
          const target = { ...file.source, ...file.copy, etag: null } as DriveRow;
          file.copy.etag = await copyFileObject(file.source, target);
          copied.push(target);
        }));
      }
      pendingIds = await withDriveTransaction("write", async (tx) => {
        // Object copying runs outside the hierarchy lock. Re-read current ACLs and content before publishing any copy.
        const current = await loadTree(tx, ids);
        await assertItemsAccess(tx, ctx, current.rows, { allowTrashed: true });
        if (current.rows.length !== tree.rows.length || current.rows.some((row) => {
          const original = tree.byId.get(row.id);
          return !original || original.updatedAt.getTime() !== row.updatedAt.getTime()
            || original.objectKey !== row.objectKey || original.etag !== row.etag;
        })) throw new DriveError("The source changed while copying. Nothing was copied; please try again.");
        await destination(tx, ctx, parentId);
        const final = planTransfer(current.roots, await destinationSiblings(tx, ctx, parentId), resolutions, "copy", parentId);
        const unchanged = final.items.length === plan.items.length && final.items.every(({ root }, index) => root.id === plan.items[index].root.id)
          && final.replaceIds.join() === plan.replaceIds.join();
        if (!unchanged) throw new DriveError("The destination changed while copying. Nothing was copied; please try again.");
        const finalNames = new Map(final.items.map(({ root, name }) => [root.id, name]));
        for (const { source, copy } of rows) copy.name = finalNames.get(source.id) ?? copy.name;
        await assertReplaceable(tx, ctx, final.replaceIds, current);
        const trashed = final.replaceIds.length ? await trashRows(tx, ctx, final.replaceIds, { reason: "replaced" }) : [];
        await assertQuota(tx, ctx, totalBytes);
        for (let index = 0; index < rows.length; index += 500) {
          await tx.insert(driveItems).values(rows.slice(index, index + 500).map((row) => row.copy));
        }
        await enqueueSearch(tx, rows.filter(({ source }) => source.kind === "file").map(({ copy }) => copy.id!));
        await recordEvents(tx, ctx, rows.filter(({ source }) => finalNames.has(source.id)).map(({ source, copy }) => ({
          action: "copy", item: { id: copy.id!, name: copy.name, kind: copy.kind, parentId }, details: { sourceId: source.id },
        })));
        return trashed;
      });
    } catch (error) {
      await Promise.allSettled(copied.map((target) => removeObject(target)));
      if (error instanceof DriveError) throw error;
      throw new DriveError("The copy couldn’t be completed. Nothing was changed.");
    }
    await cancelTrashedUploads(pendingIds);
    return { copied: plan.items.length, ids: plan.items.map(({ root }) => newIds.get(root.id)!), replacedIds: plan.replaceIds };
  });
}

export async function trashItems(ids: string[]): Promise<ActionResult<void>> {
  return driveAction((ctx) => trashDriveItems(ctx, idsSchema.parse(ids)), "trash");
}

export async function restoreItems(ids: string[]): Promise<ActionResult<DriveRestoreResult>> {
  return driveAction((ctx) => restoreDriveItems(ctx, idsSchema.parse(ids)));
}

export async function permanentlyDeleteItems(ids: string[]): Promise<ActionResult<void>> {
  return driveAction((ctx) => permanentlyDeleteDriveItems(ctx, idsSchema.parse(ids)), "trash");
}

/** Permanently deletes writable, fully accessible Trash trees. Removal continues in the background when it takes long. */
export async function emptyTrash(): Promise<ActionResult<EmptyTrashResult>> {
  return driveAction((ctx) => emptyDriveTrash(ctx), "trash");
}

export async function getTrashSummary(): Promise<ActionResult<TrashSummary>> {
  return driveAction((ctx) => trashSummary(ctx), "read");
}

export async function getArchiveManifest(ids: string[]): Promise<ActionResult<DriveArchiveManifest>> {
  return driveAction(async (ctx) => {
    ids = idsSchema.parse(ids);
    return withDriveTransaction("read", async (tx) => {
      const selected = await selectedRows(tx, ids);
      if (selected.some((row) => row.state !== "complete" || row.trashedAt)) throw new DriveError("Only available files and folders can be downloaded.");
      const tree = await loadTree(tx, ids);
      const rows = tree.rows.filter((row) => row.state === "complete" && !row.trashedAt);
      await assertItemsAccess(tx, ctx, rows);
      const included = new Set(rows.map((row) => row.id));
      return { rootIds: tree.roots.map((row) => row.id), items: rows.map(({ id, parentId, name, kind, size }) => ({ id, parentId: parentId && included.has(parentId) ? parentId : null, name, kind, size })) };
    });
  }, "read");
}

/** `expiresIn`: seconds from now; null removes the expiry; omitted keeps an existing link's expiry. */
export async function setPublic(input: { id: string; enabled: boolean; expiresIn?: number | null }): Promise<ActionResult<{ url: string | null; expiresAt: string | null }>> {
  return driveAction(async (ctx) => {
    const { id, enabled, expiresIn } = z.object({
      id: idSchema, enabled: z.boolean(), expiresIn: z.number().int().min(1).max(31_536_000, "Public links can expire up to one year from now.").nullable().optional(),
    }).parse(input);
    const { url, expiresAt, created, row } = await withDriveTransaction("write", async (tx) => {
      const row = await requireItem(tx, ctx, id);
      await assertItemAccess(tx, ctx, row, { permission: "manage" });
      if (enabled && !(await canAccessPublic(tx, row))) {
        throw new DriveError(row.kind === "folder" ? "Password-protected folders, and folders inside them, cannot have public links." : "Files in password-protected folders cannot have public links.");
      }
      const now = new Date();
      const existing = row.publicToken && (!row.publicExpiresAt || row.publicExpiresAt > now);
      const publicToken = enabled ? (existing ? row.publicToken : createPublicToken()) : null;
      const publicExpiresAt = !enabled ? null : expiresIn === undefined ? (existing ? row.publicExpiresAt : null) : expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000);
      const sharedByEmail = enabled ? (existing ? row.sharedByEmail : ctx.email) : null;
      await tx.update(driveItems).set({ publicToken, publicExpiresAt, sharedByEmail, updatedAt: now }).where(eq(driveItems.id, id));
      const expiresAt = publicExpiresAt?.toISOString() ?? null;
      const item = { id: row.id, name: row.name, kind: row.kind, parentId: row.parentId };
      if (enabled && (!existing || expiresIn !== undefined)) await recordEvents(tx, ctx, [{ action: "share", item, details: { expiresAt } }]);
      else if (!enabled && existing) await recordEvents(tx, ctx, [{ action: "unshare", item }]);
      return { url: publicToken ? publicShareUrl(publicToken) : null, expiresAt, created: enabled && !existing, row };
    });
    // A new public file link sends the file to VirusTotal; the share dialog tells the user before they create it.
    if (created && row.kind === "file") await queueScanSubmission(row, ctx).catch((error) => console.error(`Could not queue a virus scan for ${row.id}`, error));
    return { url, expiresAt };
  }, "share");
}

export async function getDownloadUrl(id: string): Promise<ActionResult<{ url: string }>> {
  return driveAction(async (ctx) => {
    id = idSchema.parse(id);
    return withDriveTransaction("read", async (tx) => {
      const row = await requireItem(tx, ctx, id);
      const url = await signDownload(row);
      if (!url) throw new DriveError("This file is not available for download.");
      return { url };
    });
  }, "read");
}

export async function getPreviewUrl(id: string): Promise<ActionResult<{ url: string | null }>> {
  return driveAction(async (ctx) => {
    id = idSchema.parse(id);
    return withDriveTransaction("read", async (tx) => {
      const row = await requireItem(tx, ctx, id);
      return { url: await signDownload(row, true) };
    });
  }, "read");
}
