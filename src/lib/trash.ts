import "server-only";

import type { DriveContext, DriveTransaction } from "@/lib/drive-access";
import type { DriveRow } from "@/lib/drive-schema";
import type { DriveRestoreResult, EmptyTrashResult, TrashSummary } from "@/lib/drive-types";
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { assertItemAccess, assertItemsAccess, discoverableRootsCondition, visibleItemsCondition, withDriveTransaction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { driveEvents, driveFileVersions, driveFolderUnlocks, driveItems, driveUploadWork } from "@/lib/drive-schema";
import { childFirst, folderPath, loadTree, restoreRows, selectedRows } from "@/lib/drive-tree";
import { cleanupUpload, ensureUploadWork, pruneExpiredUploads, removeObject, removeVersionObject } from "@/lib/storage";
import { withStorageObjectLock } from "@/lib/storage-work";
import { recordEvents, SYSTEM_ACTOR, type DriveEventDetails } from "@/lib/activity";

async function removeRows(ids: string[]): Promise<void> {
  const plan = await withDriveTransaction("write", async (tx) => {
    const rows = await tx.select().from(driveItems).where(and(inArray(driveItems.id, ids), isNotNull(driveItems.deletionStartedAt)));
    const fileIds = rows.filter((row) => row.kind === "file").map((row) => row.id);
    const versions = fileIds.length ? await tx.select().from(driveFileVersions).where(inArray(driveFileVersions.itemId, fileIds)) : [];
    const replacements = fileIds.length ? await tx.select().from(driveItems).where(inArray(driveItems.replacesId, fileIds)) : [];
    const pending = [...rows.filter((row) => row.state === "pending"), ...replacements];
    for (const row of pending) {
      await ensureUploadWork(tx, row);
      await tx.update(driveUploadWork).set({ status: "cancelled" }).where(eq(driveUploadWork.id, row.id));
      await tx.update(driveItems).set({ deletionStartedAt: new Date() }).where(eq(driveItems.id, row.id));
    }
    return { rows, versions, pending };
  });
  // No hierarchy lock while waiting on object claims or storage. The committed
  // deletion gate prevents restoration, new versions and fresh upload signing.
  for (const row of plan.pending) await cleanupUpload(row.id);
  for (const version of plan.versions) await withStorageObjectLock(version.objectKey, () => removeVersionObject(version));
  for (const row of plan.rows) if (row.kind === "file" && row.state === "complete") await withStorageObjectLock(row.objectKey!, () => removeObject(row));
  await withDriveTransaction("write", async (tx) => {
    for (const row of childFirst(plan.rows)) await tx.delete(driveItems).where(and(eq(driveItems.id, row.id), isNotNull(driveItems.deletionStartedAt)));
  });
}

/**
 * Moves items (with their contents) to Trash inside the caller's write transaction and logs one
 * `trash` event per selected root. Returns pending uploads to pass to `cancelTrashedUploads` after commit.
 */
export async function trashRows(tx: DriveTransaction, ctx: DriveContext, ids: string[], details?: DriveEventDetails): Promise<string[]> {
  const selected = await selectedRows(tx, ids);
  if (selected.some((row) => row.state !== "complete" || row.trashedAt)) {
    throw new DriveError("Only available files and folders can be moved to Trash.");
  }
  const tree = await loadTree(tx, ids);
  await assertItemsAccess(tx, ctx, tree.rows, { allowTrashed: true, permission: "write" });
  await assertItemsAccess(tx, ctx, selected, { permission: "write" });
  const groupById = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const row of childFirst(tree.rows).reverse()) {
    const group = (row.parentId ? groupById.get(row.parentId) : undefined) ?? row.id;
    groupById.set(row.id, group);
    if (row.trashedAt) continue;
    const members = groups.get(group) ?? [];
    members.push(row.id);
    groups.set(group, members);
  }
  const now = new Date();
  for (const [trashRootId, members] of groups) {
    await tx.update(driveItems).set({ trashedAt: now, trashRootId, updatedAt: now }).where(inArray(driveItems.id, members));
  }
  await tx.update(driveItems).set({ publicToken: null, publicExpiresAt: null, sharedByEmail: null }).where(inArray(driveItems.id, tree.rows.map((row) => row.id)));
  await recordEvents(tx, ctx, tree.roots.map((row) => ({ action: "trash", item: { id: row.id, name: row.name, kind: row.kind, parentId: row.parentId }, details })));
  return tree.rows.filter((row) => row.state === "pending").map((row) => row.id);
}

/** Pending uploads are irreversibly cancelled by the committed trash gate first. Storage failure leaves hidden pending rows for the scheduled cleanup to retry. */
export async function cancelTrashedUploads(pendingIds: string[]): Promise<void> {
  if (!pendingIds.length) return;
  await withDriveTransaction("write", async (tx) => {
    const rows = await tx.select().from(driveItems).where(and(inArray(driveItems.id, pendingIds), eq(driveItems.state, "pending"), isNotNull(driveItems.trashedAt)));
    for (const row of rows) {
      await ensureUploadWork(tx, row);
      await tx.update(driveUploadWork).set({ status: "cancelled" }).where(eq(driveUploadWork.id, row.id));
      await tx.update(driveItems).set({ deletionStartedAt: new Date() }).where(eq(driveItems.id, row.id));
    }
  }).catch(() => undefined);
  for (const id of pendingIds) await cleanupUpload(id).catch(() => undefined);
}

export async function trashDriveItems(ctx: DriveContext, ids: string[]): Promise<void> {
  await cancelTrashedUploads(await withDriveTransaction("write", (tx) => trashRows(tx, ctx, ids)));
}

export async function restoreDriveItems(ctx: DriveContext, ids: string[]): Promise<DriveRestoreResult> {
  return withDriveTransaction("write", async (tx) => {
    const selected = await selectedRows(tx, ids);
    if (selected.some((row) => row.state !== "complete" || !row.trashedAt)) throw new DriveError("Only items in Trash can be restored.");
    const tree = await loadTree(tx, ids);
    const selectedIds = new Set(ids);
    // Rows already being deleted stay behind (hidden in Trash) for the deletion to finish.
    const rows = restoreRows(tree, ids).filter((row) => !row.deletionStartedAt || selectedIds.has(row.id));
    await assertItemsAccess(tx, ctx, rows, { allowTrashed: true, permission: "write" });
    const restoring = new Set(rows.map((row) => row.id));
    // A failed permanent deletion must never restore already removed file bytes.
    for (const row of rows) {
      if (row.deletionStartedAt) throw new DriveError("This item is being permanently deleted and can’t be restored.");
    }
    const relocated = new Set<string>();
    for (const row of rows) {
      if (!row.parentId || restoring.has(row.parentId)) continue;
      const path = await folderPath(tx, row.parentId);
      const parentAvailable = path.every((ancestor) => !ancestor.deletionStartedAt && (!ancestor.trashedAt || restoring.has(ancestor.id)));
      if (!parentAvailable) {
        await tx.update(driveItems).set({ parentId: null }).where(eq(driveItems.id, row.id));
        relocated.add(row.id);
      } else if (path.length) {
        await assertItemAccess(tx, ctx, path[path.length - 1], { allowTrashed: true, permission: "write" });
      }
    }
    await tx.update(driveItems).set({ trashedAt: null, trashRootId: null, publicToken: null, publicExpiresAt: null, sharedByEmail: null, updatedAt: new Date() })
      .where(inArray(driveItems.id, rows.map((row) => row.id)));
    await recordEvents(tx, ctx, tree.roots.filter((row) => restoring.has(row.id)).map((row) => relocated.has(row.id)
      ? { action: "restore", item: { id: row.id, name: row.name, kind: row.kind, parentId: null }, details: { restoredToRoot: true } }
      : { action: "restore", item: { id: row.id, name: row.name, kind: row.kind, parentId: row.parentId } }));
    return { restoredToRoot: relocated.size };
  });
}

/** Commits irreversible deletion intent: from here on rows are hidden from Trash and only ever removed. */
async function startDeletion(tx: DriveTransaction, rows: DriveRow[]): Promise<void> {
  if (!rows.length) return;
  await tx.update(driveItems).set({ deletionStartedAt: sql`coalesce(${driveItems.deletionStartedAt}, now())`, publicToken: null, publicExpiresAt: null, sharedByEmail: null })
    .where(inArray(driveItems.id, rows.map((row) => row.id)));
}

const REMOVE_BATCH = 25;
/** Inline share of a deletion; the rest continues after the response, then the daily cleanup retries. */
const REMOVE_BUDGET_MS = 20_000;

/** Removes deleting rows child-first, batch by batch, until the deadline or a failure. Returns ids left behind. */
async function removeDeleting(ids: string[], deadline = Infinity): Promise<string[]> {
  if (!ids.length) return [];
  const ordered = childFirst(await withDriveTransaction("read", (tx) => tx.select().from(driveItems).where(and(inArray(driveItems.id, ids), isNotNull(driveItems.deletionStartedAt)))));
  let next = 0;
  while (next < ordered.length && Date.now() < deadline) {
    const batch = ordered.slice(next, next + REMOVE_BATCH).map((row) => row.id);
    try {
      await removeRows(batch);
    } catch {
      break;
    }
    next += batch.length;
  }
  return ordered.slice(next).map((row) => row.id);
}

async function finishDeletion(ids: string[]): Promise<Set<string>> {
  const remaining = await removeDeleting(ids, Date.now() + REMOVE_BUDGET_MS);
  if (remaining.length) after(() => removeDeleting(remaining).then(() => undefined));
  return new Set(remaining);
}

export async function permanentlyDeleteDriveItems(ctx: DriveContext, ids: string[]): Promise<void> {
  const deleting = await withDriveTransaction("write", async (tx) => {
    const selected = await selectedRows(tx, ids);
    if (selected.some((row) => row.state !== "complete" || !row.trashedAt)) throw new DriveError("Move files and folders to Trash before permanently deleting them.");
    const tree = await loadTree(tx, ids);
    if (tree.rows.some((row) => !row.trashedAt)) throw new DriveError("This folder contains items that are not in Trash.");
    await assertItemsAccess(tx, ctx, tree.rows, { allowTrashed: true, permission: "write" });
    await startDeletion(tx, tree.rows);
    await recordEvents(tx, ctx, tree.roots.map((row) => ({ action: "delete", item: { id: row.id, name: row.name, kind: row.kind, parentId: row.parentId } })));
    return tree.rows.map((row) => row.id);
  });
  await finishDeletion(deleting);
}

/** Plans only fully writable Trash trees; invisible items never contribute even to skipped counts. */
async function planEmptyTrash(tx: DriveTransaction, ctx: DriveContext): Promise<{ roots: string[]; rows: DriveRow[]; bytes: number; skippedLocked: number }> {
  // The same top-level entries the Trash view lists.
  const rootConditions = [
    eq(driveItems.state, "complete"), isNotNull(driveItems.trashedAt), isNull(driveItems.deletionStartedAt),
    or(
      sql`not exists (select 1 from drive_items parent where parent.id = ${driveItems.parentId} and parent.trashed_at is not null and parent.trash_root_id is not distinct from ${driveItems.trashRootId})`,
      discoverableRootsCondition(ctx, { trash: true }),
    ),
  ];
  const visible = await tx.select({ id: driveItems.id }).from(driveItems).where(and(...rootConditions, visibleItemsCondition(ctx, { trash: true })));
  const roots: string[] = [];
  const rows = new Map<string, DriveRow>();
  for (const { id } of visible) {
    const tree = await loadTree(tx, [id]);
    if (tree.rows.some((row) => !row.trashedAt)) continue;
    try {
      await assertItemsAccess(tx, ctx, tree.rows, { allowTrashed: true, permission: "write" });
    } catch (error) {
      if (error instanceof DriveError) continue;
      throw error;
    }
    roots.push(id);
    for (const row of tree.rows) rows.set(row.id, row);
  }
  const all = [...rows.values()];
  const bytes = all.reduce((sum, row) => sum + (row.kind === "file" && row.state === "complete" ? row.size : 0), 0);
  return { roots, rows: all, bytes, skippedLocked: visible.length - roots.length };
}

export async function trashSummary(ctx: DriveContext): Promise<TrashSummary> {
  const plan = await withDriveTransaction("read", (tx) => planEmptyTrash(tx, ctx));
  return { count: plan.roots.length, bytes: plan.bytes, skippedLocked: plan.skippedLocked };
}

/** Permanently deletes fully writable Trash trees; unreadable or read-only descendants keep their tree intact. */
export async function emptyDriveTrash(ctx: DriveContext): Promise<EmptyTrashResult> {
  const plan = await withDriveTransaction("write", async (tx) => {
    const planned = await planEmptyTrash(tx, ctx);
    await startDeletion(tx, planned.rows);
    if (planned.roots.length) await recordEvents(tx, ctx, [{ action: "empty_trash", item: { id: null, name: "Trash", kind: "folder", parentId: null }, details: { count: planned.roots.length, bytes: planned.bytes } }]);
    return planned;
  });
  const remaining = await finishDeletion(plan.rows.map((row) => row.id));
  const pending = plan.roots.filter((id) => remaining.has(id)).length;
  return { deleted: plan.roots.length - pending, skippedLocked: plan.skippedLocked, pending };
}

export async function purgeExpiredTrash(): Promise<{ purged: number; failed: number }> {
  await withDriveTransaction("write", async (tx) => {
    await tx.delete(driveFolderUnlocks).where(lte(driveFolderUnlocks.expiresAt, new Date()));
    await tx.delete(driveEvents).where(lt(driveEvents.at, sql`now() - interval '365 days'`));
  });
  await pruneExpiredUploads();
  let purged = 0;
  let failed = 0;
  const attempted = new Set<string>();
  // Child-first leaf batches preserve younger independent trash groups and bound
  // each scheduled run. Persisted explicit-delete intent is retried at any age.
  for (let batch = 0; batch < 4; batch += 1) {
    const ids = await withDriveTransaction("write", async (tx) => {
      const conditions = [
        isNotNull(driveItems.trashedAt),
        or(isNotNull(driveItems.deletionStartedAt), lte(driveItems.trashedAt, sql`now() - interval '30 days'`)),
        sql`not exists (select 1 from drive_items child where child.parent_id = ${driveItems.id})`,
      ];
      if (attempted.size) conditions.push(sql`${driveItems.id} not in (${sql.join([...attempted].map((id) => sql`${id}::uuid`), sql`, `)})`);
      const rows = await tx.select({ id: driveItems.id }).from(driveItems).where(and(...conditions)).orderBy(asc(driveItems.trashedAt), asc(driveItems.id)).limit(100);
      const deletingIds = rows.map((row) => row.id);
      if (deletingIds.length) {
        // Expiring any member makes its old trash group irreversibly deleting;
        // otherwise a later restore could silently return only the surviving files.
        // Stop at independent groups, young ancestors, or prior explicit intent.
        const marked = await tx.update(driveItems).set({ deletionStartedAt: sql`coalesce(${driveItems.deletionStartedAt}, now())`, publicToken: null, publicExpiresAt: null, sharedByEmail: null }).where(sql`${driveItems.id} in (
          with recursive expiring as (
            select item.id, item.parent_id, item.trash_root_id from drive_items item
            where item.id in (${sql.join(deletingIds.map((id) => sql`${id}::uuid`), sql`, `)})
              and item.deletion_started_at is null
            union
            select parent.id, parent.parent_id, parent.trash_root_id
            from drive_items parent join expiring child on parent.id = child.parent_id
            where parent.trash_root_id is not distinct from child.trash_root_id
              and parent.trashed_at <= now() - interval '30 days'
              and parent.deletion_started_at is null
          ) select id from expiring
          union select item.id from drive_items item
          where item.id in (${sql.join(deletingIds.map((id) => sql`${id}::uuid`), sql`, `)})
        )`).returning({
          id: driveItems.id, name: driveItems.name, kind: driveItems.kind, parentId: driveItems.parentId, trashRootId: driveItems.trashRootId,
          // now() is this transaction's start: true only for rows expired right here, not earlier explicit deletions.
          expiredNow: sql<boolean>`${driveItems.deletionStartedAt} = now()`,
        });
        await recordEvents(tx, SYSTEM_ACTOR, marked.filter((row) => row.expiredNow && row.id === row.trashRootId)
          .map((row) => ({ action: "delete", item: { id: row.id, name: row.name, kind: row.kind, parentId: row.parentId }, details: { reason: "expired" } })));
      }
      return deletingIds;
    });
    if (!ids.length) break;
    for (const id of ids) {
      attempted.add(id);
      try {
        const [row] = await withDriveTransaction("read", (tx) => tx.select().from(driveItems).where(and(eq(driveItems.id, id), isNotNull(driveItems.trashedAt), isNotNull(driveItems.deletionStartedAt))));
        const removed = Boolean(row);
        if (removed) await removeRows([id]);
        if (removed) purged += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { purged, failed };
}
