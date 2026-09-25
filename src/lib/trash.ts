import "server-only";

import type { DriveContext, DriveTransaction } from "@/lib/drive-access";
import type { DriveRow } from "@/lib/drive-schema";
import type { DriveRestoreResult } from "@/lib/drive-types";
import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { assertItemAccess, assertItemsAccess, withDriveTransaction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { driveFolderUnlocks, driveItems } from "@/lib/drive-schema";
import { childFirst, folderPath, loadTree, restoreRows, selectedRows } from "@/lib/drive-tree";
import { pruneExpiredUploads, removeObject } from "@/lib/storage";

async function removeRows(tx: DriveTransaction, rows: DriveRow[]): Promise<void> {
  // Keep every tombstone until all object deletions succeed. A rollback can never
  // make partially deleted data restorable: deletionStartedAt was committed first.
  for (const row of rows) if (row.kind === "file") await removeObject(row);
  for (const row of childFirst(rows)) await tx.delete(driveItems).where(eq(driveItems.id, row.id));
}

export async function trashDriveItems(ctx: DriveContext, ids: string[]): Promise<void> {
  const pendingIds = await withDriveTransaction("write", async (tx) => {
    const selected = await selectedRows(tx, ids);
    if (selected.some((row) => row.state !== "complete" || row.trashedAt)) {
      throw new DriveError("Only available files and folders can be moved to Trash.");
    }
    const tree = await loadTree(tx, ids);
    await assertItemsAccess(tx, ctx, tree.rows, { allowTrashed: true });
    await assertItemsAccess(tx, ctx, selected);
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
    return tree.rows.filter((row) => row.state === "pending").map((row) => row.id);
  });
  // Pending uploads are irreversibly cancelled by the committed trash gate first.
  // Storage failure leaves hidden pending rows for the scheduled cleanup to retry.
  if (pendingIds.length) {
    await withDriveTransaction("write", async (tx) => {
      const rows = await tx.select().from(driveItems).where(and(inArray(driveItems.id, pendingIds), eq(driveItems.state, "pending"), isNotNull(driveItems.trashedAt)));
      for (const row of rows) {
        try {
          await removeObject(row);
        } catch {
          continue;
        }
        await tx.delete(driveItems).where(eq(driveItems.id, row.id));
      }
    }).catch(() => undefined);
  }
}

export async function restoreDriveItems(ctx: DriveContext, ids: string[]): Promise<DriveRestoreResult> {
  return withDriveTransaction("write", async (tx) => {
    const selected = await selectedRows(tx, ids);
    if (selected.some((row) => row.state !== "complete" || !row.trashedAt)) throw new DriveError("Only items in Trash can be restored.");
    const tree = await loadTree(tx, ids);
    const rows = restoreRows(tree, ids);
    await assertItemsAccess(tx, ctx, rows, { allowTrashed: true });
    const restoring = new Set(rows.map((row) => row.id));
    // A failed permanent deletion must never restore already removed file bytes.
    for (const row of rows) {
      if (row.deletionStartedAt) throw new DriveError("Permanent deletion has already started. Retry deleting this item instead of restoring it.");
    }
    let restoredToRoot = 0;
    for (const row of rows) {
      if (!row.parentId || restoring.has(row.parentId)) continue;
      const path = await folderPath(tx, row.parentId);
      const parentAvailable = path.every((ancestor) => !ancestor.deletionStartedAt && (!ancestor.trashedAt || restoring.has(ancestor.id)));
      if (!parentAvailable) {
        await tx.update(driveItems).set({ parentId: null }).where(eq(driveItems.id, row.id));
        restoredToRoot += 1;
      } else if (path.length) {
        await assertItemAccess(tx, ctx, path[path.length - 1], { allowTrashed: true });
      }
    }
    await tx.update(driveItems).set({ trashedAt: null, trashRootId: null, publicToken: null, publicExpiresAt: null, sharedByEmail: null, updatedAt: new Date() })
      .where(inArray(driveItems.id, rows.map((row) => row.id)));
    return { restoredToRoot };
  });
}

export async function permanentlyDeleteDriveItems(ctx: DriveContext, ids: string[]): Promise<void> {
  const deleting = await withDriveTransaction("write", async (tx) => {
    const selected = await selectedRows(tx, ids);
    if (selected.some((row) => row.state !== "complete" || !row.trashedAt)) throw new DriveError("Move files and folders to Trash before permanently deleting them.");
    const tree = await loadTree(tx, ids);
    if (tree.rows.some((row) => !row.trashedAt)) throw new DriveError("This folder contains items that are not in Trash.");
    await assertItemsAccess(tx, ctx, tree.rows, { allowTrashed: true });
    const deletingIds = tree.rows.map((row) => row.id);
    await tx.update(driveItems).set({ deletionStartedAt: sql`coalesce(${driveItems.deletionStartedAt}, now())`, publicToken: null, publicExpiresAt: null, sharedByEmail: null })
      .where(inArray(driveItems.id, deletingIds));
    return deletingIds;
  });
  try {
    await withDriveTransaction("write", async (tx) => {
      const rows = await tx.select().from(driveItems).where(inArray(driveItems.id, deleting));
      await removeRows(tx, rows);
    });
  } catch {
    throw new DriveError("Some files could not be permanently deleted. They remain in Trash; retry deletion to finish safely.");
  }
}

export async function purgeExpiredTrash(): Promise<{ purged: number; failed: number }> {
  await withDriveTransaction("write", async (tx) => {
    await tx.delete(driveFolderUnlocks).where(lte(driveFolderUnlocks.expiresAt, new Date()));
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
        await tx.update(driveItems).set({ deletionStartedAt: sql`coalesce(${driveItems.deletionStartedAt}, now())`, publicToken: null, publicExpiresAt: null, sharedByEmail: null }).where(sql`${driveItems.id} in (
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
        )`);
      }
      return deletingIds;
    });
    if (!ids.length) break;
    for (const id of ids) {
      attempted.add(id);
      try {
        const removed = await withDriveTransaction("write", async (tx) => {
          const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id));
          if (!row) return false;
          if (!row.trashedAt || !row.deletionStartedAt) return false;
          await removeRows(tx, [row]);
          return true;
        });
        if (removed) purged += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { purged, failed };
}
