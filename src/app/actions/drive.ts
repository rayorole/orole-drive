"use server";

import type { SQL } from "drizzle-orm";
import type { DriveContext, DriveTransaction } from "@/lib/drive-access";
import type { DriveRow } from "@/lib/drive-schema";
import type { ActionResult, DriveArchiveManifest, DriveItem, DriveListInput, DriveListing, DriveRestoreResult, UploadTicket } from "@/lib/drive-types";
import { randomUUID } from "node:crypto";
import { and, arrayContains, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { assertItemAccess, assertItemsAccess, canAccessPublic, driveAction, getItemAccess, getItemsAccess, visibleItemsCondition, withDriveTransaction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { driveActivity, driveFavorites, driveItems } from "@/lib/drive-schema";
import { assertMoveDepth, childFirst, folderPath, loadTree, MAX_FOLDER_DEPTH, selectedRows } from "@/lib/drive-tree";
import { MAX_UPLOAD_BYTES, MULTIPART_THRESHOLD_BYTES } from "@/lib/drive-types";
import { abortMultipartUpload, commitUpload, copyFileObject, createMultipartUpload, createObjectKey, createPublicToken, publicShareUrl, removeObject, removeStagedObject, signDownload, signUpload, toDriveItem } from "@/lib/storage";
import { permanentlyDeleteDriveItems, restoreDriveItems, trashDriveItems } from "@/lib/trash";
import { queueScanSubmission } from "@/lib/virus-scan-jobs";
import { copyName } from "@/lib/copy-name";
import { driveVirusScans } from "@/lib/virustotal-schema";

const idSchema = z.uuid("Choose a valid file or folder.");
const idsSchema = z.array(idSchema).min(1, "Choose at least one file or folder.").max(1000, "Choose up to 1,000 items at a time.").transform((ids) => [...new Set(ids)]);
const parentSchema = idSchema.nullable().optional().transform((id) => id ?? null);
const nameSchema = z.string().trim().normalize().min(1, "Enter a name.").max(255, "Names must be 255 characters or fewer.").refine(
  (name) => name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") &&
    !/[\p{Cc}\p{Bidi_Control}]/u.test(name) && name.isWellFormed() && Buffer.byteLength(name, "utf8") <= 255,
  "Use a name without slashes or control characters, up to 255 bytes long.",
);
const mimeSchema = z.string().trim().toLowerCase().max(127).regex(
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/,
  "Choose a file with a valid content type.",
);

const itemType = sql<string>`case
  when ${driveItems.kind} = 'folder' then 'folder'
  when ${driveItems.name} ~* '\\.(json|jsonl|js|jsx|ts|tsx|mjs|cjs|html?|css|scss|less|xml|svg|ya?ml|toml|ini|conf|sh|bash|zsh|ps1|bat|cmd|py|rb|php|go|rs|java|kt|swift|c|h|cpp|hpp|cs|sql|vue|svelte|dockerfile|gitignore)$'
    or ${driveItems.mimeType} in ('application/json', 'application/xml', 'text/html', 'text/css', 'text/javascript', 'application/javascript') then 'code'
  when ${driveItems.mimeType} like 'image/%' then 'image'
  when ${driveItems.mimeType} like 'video/%' then 'video'
  when ${driveItems.mimeType} like 'audio/%' then 'audio'
  when ${driveItems.mimeType} = 'application/pdf' or ${driveItems.name} ~* '\\.pdf$' then 'pdf'
  when ${driveItems.name} ~* '\\.(zip|rar|7z|tar|gz|bz2|xz|tgz|zst)$'
    or ${driveItems.mimeType} in ('application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed', 'application/gzip', 'application/x-tar') then 'archive'
  when ${driveItems.mimeType} like 'text/%' or ${driveItems.name} ~* '\\.(txt|md|markdown|csv|tsv|log|rst|nfo)$' then 'text'
  else 'other' end`;

async function itemData(tx: DriveTransaction, ctx: DriveContext, row: DriveRow): Promise<DriveItem> {
  return { ...toDriveItem(row), ...await getItemAccess(tx, ctx, row) };
}

async function requireItem(tx: DriveTransaction, ctx: DriveContext, id: string): Promise<DriveRow> {
  const [row] = await tx.select().from(driveItems).where(and(eq(driveItems.id, id), eq(driveItems.state, "complete")));
  if (!row) throw new DriveError("This file or folder is no longer available.");
  await assertItemAccess(tx, ctx, row);
  return row;
}

async function destination(tx: DriveTransaction, ctx: DriveContext, parentId: string | null, addingFolder = false): Promise<DriveRow[]> {
  const path = await folderPath(tx, parentId);
  if (path.length) await assertItemAccess(tx, ctx, path[path.length - 1]);
  else await assertItemsAccess(tx, ctx, []);
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
      const path = await folderPath(tx, folderId);
      const current = path.at(-1);
      if (current) {
        await assertItemAccess(tx, ctx, current, { allowTrashed: trash });
        if (trash && !current.trashedAt) throw new DriveError("This folder is not in Trash.");
      }
      const global = !foldersOnly && Boolean(search || type !== "all" || minSize !== undefined || maxSize !== undefined || after || before || tags?.length);
      const conditions: SQL[] = [eq(driveItems.state, "complete"), visibleItemsCondition(ctx, { trash })];
      conditions.push(trash ? isNotNull(driveItems.trashedAt) : isNull(driveItems.trashedAt));
      if (foldersOnly) conditions.push(eq(driveItems.kind, "folder"));
      else if (filter === "public") conditions.push(eq(driveItems.kind, "file"), isNotNull(driveItems.publicToken), sql`(${driveItems.publicExpiresAt} is null or ${driveItems.publicExpiresAt} > clock_timestamp())`);
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
        else if (trash) conditions.push(sql`not exists (
          select 1 from drive_items parent where parent.id = ${driveItems.parentId}
          and parent.trashed_at is not null and parent.trash_root_id is not distinct from ${driveItems.trashRootId}
        )`);
        else conditions.push(isNull(driveItems.parentId));
      }
      const sort = parsed.sort ?? (filter === "recent" ? "updatedAt" : "name");
      const direction = parsed.direction ?? (filter === "recent" ? "desc" : "asc");
      const order = direction === "asc" ? asc : desc;
      const recentActivityColumn = sql`(select accessed_at from drive_activity where item_id = ${driveItems.id} and user_id = ${ctx.userId})`;
      const sortColumn = filter === "recent" && parsed.sort === undefined ? recentActivityColumn
        : sort === "name" ? sql`lower(${driveItems.name})` : sort === "updatedAt" ? driveItems.updatedAt : sort === "size" ? driveItems.size : itemType;
      const ordering = sort === "name" ? [desc(driveItems.kind), order(sortColumn), asc(driveItems.id)] : [order(sortColumn), asc(sql`lower(${driveItems.name})`), asc(driveItems.id)];
      const query = tx.select().from(driveItems).where(and(...conditions)).orderBy(...ordering);
      const rows = filter === "recent" && !global ? await query.limit(100) : await query;
      const [totals] = await tx.select({
        totalBytes: sql<number>`coalesce(sum(${driveItems.size}), 0)`.mapWith(Number), totalFiles: count(),
      }).from(driveItems).where(and(eq(driveItems.state, "complete"), eq(driveItems.kind, "file"), visibleItemsCondition(ctx), isNull(driveItems.trashedAt)));
      const access = await getItemsAccess(tx, ctx, current ? [...rows, current] : rows);
      const favoriteScope = current ? [...rows, current] : rows;
      const favoriteIds = favoriteScope.length ? new Set((await tx.select({ id: driveFavorites.itemId }).from(driveFavorites)
        .where(and(eq(driveFavorites.userId, ctx.userId), inArray(driveFavorites.itemId, favoriteScope.map((row) => row.id))))).map((row) => row.id)) : new Set<string>();
      const fileIds = rows.filter((row) => row.kind === "file").map((row) => row.id);
      const scans = fileIds.length ? new Map((await tx.select({ id: driveVirusScans.itemId, status: driveVirusScans.status })
        .from(driveVirusScans).where(inArray(driveVirusScans.itemId, fileIds))).map((scan) => [scan.id, scan.status])) : new Map<string, string>();
      const scanStatus = (id: string) => {
        const status = scans.get(id);
        return status === "pending" ? "scanning" as const : status === "clean" || status === "suspicious" || status === "malicious" ? status : undefined;
      };
      return {
        items: rows.map((row) => ({ ...toDriveItem(row), ...access.get(row.id)!, isFavorite: favoriteIds.has(row.id), scanStatus: scanStatus(row.id) })),
        breadcrumbs: path.map(({ id, name }) => ({ id, name })),
        currentFolder: current ? { ...toDriveItem(current), ...access.get(current.id)!, isFavorite: favoriteIds.has(current.id) } : null,
        totalBytes: totals.totalBytes, totalFiles: totals.totalFiles,
      };
    });
  }, "read");
}

export async function createFolder(input: { name: string; parentId?: string | null }): Promise<ActionResult<DriveItem>> {
  return driveAction(async (ctx) => {
    const { name, parentId } = z.object({ name: nameSchema, parentId: parentSchema }).parse(input);
    return withDriveTransaction("write", async (tx) => {
      await destination(tx, ctx, parentId, true);
      const [folder] = await tx.insert(driveItems).values({ id: randomUUID(), name, parentId, kind: "folder", state: "complete", size: 0 }).returning();
      return itemData(tx, ctx, folder);
    });
  });
}

export async function beginUpload(input: { name: string; size: number; mimeType: string; parentId?: string | null }): Promise<ActionResult<UploadTicket>> {
  return driveAction(async (ctx) => {
    const { name, size, mimeType, parentId } = z.object({
      name: nameSchema, size: z.number().int().min(0).max(MAX_UPLOAD_BYTES, "Files must be 5 GiB or smaller."), mimeType: mimeSchema, parentId: parentSchema,
    }).parse(input);
    let multipartRow: DriveRow | undefined;
    try {
      return await withDriveTransaction("write", async (tx) => {
        await destination(tx, ctx, parentId);
        const id = randomUUID();
        const [row] = await tx.insert(driveItems).values({
          id, name, size, mimeType, parentId, kind: "file", state: "pending", objectKey: createObjectKey(id),
        }).returning();
        if (size < MULTIPART_THRESHOLD_BYTES) return signUpload(row);
        const multipartUploadId = await createMultipartUpload(row);
        multipartRow = { ...row, multipartUploadId };
        await tx.update(driveItems).set({ multipartUploadId }).where(eq(driveItems.id, id));
        return signUpload(multipartRow);
      });
    } catch (error) {
      if (multipartRow) await abortMultipartUpload(multipartRow).catch(() => undefined);
      throw error;
    }
  });
}

export async function completeUpload(id: string): Promise<ActionResult<DriveItem>> {
  return driveAction(async (ctx) => {
    id = idSchema.parse(id);
    const result = await withDriveTransaction("write", async (tx) => {
      const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id)).for("update");
      if (!row || row.kind !== "file") throw new DriveError("This upload is no longer available.");
      await assertItemAccess(tx, ctx, row);
      if (row.state === "complete") return { row, item: await itemData(tx, ctx, row) };
      const etag = await commitUpload(row);
      const [completed] = await tx.update(driveItems).set({ state: "complete", etag, updatedAt: new Date() }).where(eq(driveItems.id, id)).returning();
      await tx.insert(driveActivity).values({ userId: ctx.userId, itemId: id, accessedAt: new Date() })
        .onConflictDoUpdate({ target: [driveActivity.userId, driveActivity.itemId], set: { accessedAt: new Date() } });
      return { row: completed, item: await itemData(tx, ctx, completed) };
    });
    // Never remove staging before the database commit: a rolled-back single PUT
    // completion must still be retryable with the original verified source.
    await removeStagedObject(result.row).catch(() => undefined);
    return result.item;
  });
}

export async function cancelUpload(id: string): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    id = idSchema.parse(id);
    await withDriveTransaction("write", async (tx) => {
      const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id)).for("update");
      if (!row) return;
      if (row.kind !== "file" || row.state !== "pending") throw new DriveError("This upload has already completed. Move the file to Trash instead.");
      await assertItemAccess(tx, ctx, row, { allowTrashed: true });
      await removeObject(row);
      await tx.delete(driveItems).where(eq(driveItems.id, id));
    });
  });
}

export async function renameItem(input: { id: string; name: string }): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    const { id, name } = z.object({ id: idSchema, name: nameSchema }).parse(input);
    await withDriveTransaction("write", async (tx) => {
      await requireItem(tx, ctx, id);
      await tx.update(driveItems).set({ name, updatedAt: new Date() }).where(eq(driveItems.id, id));
    });
  });
}

export async function moveItems(input: { ids: string[]; parentId: string | null }): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    const { ids, parentId } = z.object({ ids: idsSchema, parentId: parentSchema }).parse(input);
    await withDriveTransaction("write", async (tx) => {
      const selected = await selectedRows(tx, ids);
      if (selected.some((row) => row.state !== "complete" || row.trashedAt)) throw new DriveError("Only available files and folders can be moved.");
      const tree = await loadTree(tx, ids);
      await assertItemsAccess(tx, ctx, tree.rows, { allowTrashed: true });
      await assertItemsAccess(tx, ctx, selected);
      const path = await destination(tx, ctx, parentId);
      assertMoveDepth(tree, path);
      if (path.some((folder) => Boolean(folder.passwordHash))) {
        await tx.update(driveItems).set({ publicToken: null, publicExpiresAt: null, sharedByEmail: null }).where(inArray(driveItems.id, tree.rows.map((row) => row.id)));
      }
      await tx.update(driveItems).set({ parentId, updatedAt: new Date() }).where(inArray(driveItems.id, tree.roots.map((row) => row.id)));
    });
  });
}

const MAX_COPY_ITEMS = 2_000;

/**
 * Copies files and folders (with everything inside) into a folder. R2 duplicates the bytes server-side
 * before any row exists, so a failure part-way leaves nothing behind: copied objects are removed and
 * no row is written. Public links, favorites and scan results are not copied.
 */
export async function copyItems(input: { ids: string[]; parentId: string | null }): Promise<ActionResult<{ copied: number }>> {
  return driveAction(async (ctx) => {
    const { ids, parentId } = z.object({ ids: idsSchema, parentId: parentSchema }).parse(input);
    const plan = await withDriveTransaction("read", async (tx) => {
      const selected = await selectedRows(tx, ids);
      if (selected.some((row) => row.state !== "complete" || row.trashedAt)) throw new DriveError("Only available files and folders can be copied.");
      const tree = await loadTree(tx, ids);
      await assertItemsAccess(tx, ctx, tree.rows, { allowTrashed: true });
      const path = await destination(tx, ctx, parentId);
      if (path.some((folder) => tree.byId.has(folder.id))) throw new DriveError("A folder can’t be copied into itself or one of its subfolders.");
      assertMoveDepth(tree, path);
      const siblings = await tx.select({ name: driveItems.name }).from(driveItems)
        .where(and(parentId ? eq(driveItems.parentId, parentId) : isNull(driveItems.parentId), isNull(driveItems.trashedAt)));
      return { tree, taken: new Set(siblings.map((row) => row.name)) };
    });

    // Parents before children; skip anything trashed or unfinished, and everything under it.
    const roots = new Set(plan.tree.roots.map((row) => row.id));
    const newIds = new Map<string, string>();
    const rows: { source: DriveRow; copy: typeof driveItems.$inferInsert }[] = [];
    for (const source of childFirst(plan.tree.rows).reverse()) {
      const isRoot = roots.has(source.id);
      if (source.state !== "complete" || source.trashedAt || (!isRoot && !newIds.has(source.parentId ?? ""))) continue;
      const id = randomUUID();
      newIds.set(source.id, id);
      const name = isRoot ? copyName(source.name, source.kind, plan.taken) : source.name;
      if (isRoot) plan.taken.add(name);
      rows.push({
        source,
        copy: {
          id, name, kind: source.kind, parentId: isRoot ? parentId : newIds.get(source.parentId!)!,
          description: source.description, tags: source.tags, folderColor: source.folderColor, state: "complete",
          ...(source.kind === "file"
            ? { size: source.size, mimeType: source.mimeType, objectKey: createObjectKey(id) }
            // A copied protected folder stays protected, under a fresh version so earlier unlocks don't carry over.
            : { passwordHash: source.passwordHash, passwordVersion: source.passwordHash ? randomUUID() : null }),
        },
      });
    }
    if (rows.length > MAX_COPY_ITEMS) throw new DriveError(`Copies are limited to ${MAX_COPY_ITEMS.toLocaleString("en")} items at a time.`);

    const files = rows.filter(({ source }) => source.kind === "file");
    const copied: DriveRow[] = [];
    try {
      for (let index = 0; index < files.length; index += 4) {
        await Promise.all(files.slice(index, index + 4).map(async (file) => {
          const target = { ...file.source, ...file.copy, etag: null } as DriveRow;
          file.copy.etag = await copyFileObject(file.source, target);
          copied.push(target);
        }));
      }
      await withDriveTransaction("write", async (tx) => {
        await destination(tx, ctx, parentId);
        for (let index = 0; index < rows.length; index += 500) {
          await tx.insert(driveItems).values(rows.slice(index, index + 500).map((row) => row.copy));
        }
      });
    } catch (error) {
      await Promise.allSettled(copied.map((target) => removeObject(target)));
      if (error instanceof DriveError) throw error;
      throw new DriveError("The copy couldn’t be completed. Nothing was changed.");
    }
    return { copied: plan.tree.roots.length };
  });
}

export async function trashItems(ids: string[]): Promise<ActionResult<void>> {
  return driveAction((ctx) => trashDriveItems(ctx, idsSchema.parse(ids)), "trash");
}

export async function restoreItems(ids: string[]): Promise<ActionResult<DriveRestoreResult>> {
  return driveAction((ctx) => restoreDriveItems(ctx, idsSchema.parse(ids)));
}

export async function permanentlyDeleteItems(ids: string[]): Promise<ActionResult<void>> {
  return driveAction((ctx) => permanentlyDeleteDriveItems(ctx, idsSchema.parse(ids)));
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
      return { rootIds: tree.roots.map((row) => row.id), items: rows.map(({ id, parentId, name, kind, size }) => ({ id, parentId, name, kind, size })) };
    });
  }, "read");
}

export async function setPublic(input: { id: string; enabled: boolean; expiresIn?: number }): Promise<ActionResult<{ url: string | null }>> {
  return driveAction(async (ctx) => {
    const { id, enabled, expiresIn } = z.object({
      id: idSchema, enabled: z.boolean(), expiresIn: z.number().int().min(1).max(31_536_000, "Public links can expire up to one year from now.").optional(),
    }).parse(input);
    const { url, created, row } = await withDriveTransaction("write", async (tx) => {
      const row = await requireItem(tx, ctx, id);
      if (row.kind !== "file") throw new DriveError("Only files can have public links. Share the files inside this folder instead.");
      if (enabled && !(await canAccessPublic(tx, row))) throw new DriveError("Files in password-protected folders cannot have public links.");
      const now = new Date();
      const existing = row.publicToken && (!row.publicExpiresAt || row.publicExpiresAt > now);
      const publicToken = enabled ? (existing ? row.publicToken : createPublicToken()) : null;
      const publicExpiresAt = enabled ? (expiresIn === undefined ? (existing ? row.publicExpiresAt : null) : new Date(now.getTime() + expiresIn * 1000)) : null;
      const sharedByEmail = enabled ? (existing ? row.sharedByEmail : ctx.email) : null;
      await tx.update(driveItems).set({ publicToken, publicExpiresAt, sharedByEmail, updatedAt: now }).where(eq(driveItems.id, id));
      return { url: publicToken ? publicShareUrl(publicToken) : null, created: enabled && !existing, row };
    });
    // A new public link sends the file to VirusTotal; the share dialog tells the user before they create it.
    if (created) await queueScanSubmission(row).catch((error) => console.error(`Could not queue a virus scan for ${row.id}`, error));
    return { url };
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
