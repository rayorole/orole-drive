import type { DriveTransaction } from "@/lib/db";
import type { DriveRow } from "@/lib/drive-schema";
import { eq, inArray, sql } from "drizzle-orm";
import { driveItems } from "@/lib/drive-schema";
import { DriveError } from "@/lib/drive-errors";

export const MAX_FOLDER_DEPTH = 64;

export type DriveTree = {
  rows: DriveRow[];
  byId: Map<string, DriveRow>;
  roots: DriveRow[];
};

export function planTree(rows: DriveRow[], selectedIds: string[]): DriveTree {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const selected = new Set(selectedIds);
  const roots: DriveRow[] = [];
  for (const id of selected) {
    const row = byId.get(id);
    if (!row) throw new DriveError("A selected file or folder is no longer available. Refresh and try again.");
    let cursor = row.parentId;
    let covered = false;
    const seen = new Set([id]);
    while (cursor && byId.has(cursor)) {
      if (seen.has(cursor)) throw new DriveError("This folder tree is unavailable.");
      seen.add(cursor);
      if (selected.has(cursor)) covered = true;
      cursor = byId.get(cursor)!.parentId;
    }
    if (!covered) roots.push(row);
  }
  return { rows, byId, roots };
}

export async function loadTree(tx: DriveTransaction, ids: string[]): Promise<DriveTree> {
  const rows = await tx.select().from(driveItems).where(sql`${driveItems.id} in (
    with recursive tree(id) as (
      select id from drive_items where id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      union
      select child.id from drive_items child join tree on child.parent_id = tree.id
    ) select id from tree
  )`);
  return planTree(rows, ids);
}

export async function selectedRows(tx: DriveTransaction, ids: string[]): Promise<DriveRow[]> {
  const rows = await tx.select().from(driveItems).where(inArray(driveItems.id, ids));
  if (rows.length !== ids.length) throw new DriveError("A selected file or folder is no longer available. Refresh and try again.");
  return rows;
}

export async function folderPath(tx: DriveTransaction, folderId: string | null): Promise<DriveRow[]> {
  const path: DriveRow[] = [];
  const seen = new Set<string>();
  let cursor = folderId;
  while (cursor) {
    if (seen.has(cursor) || path.length >= MAX_FOLDER_DEPTH) {
      throw new DriveError("Folders can be nested up to 64 levels deep.");
    }
    seen.add(cursor);
    const [folder] = await tx.select().from(driveItems).where(eq(driveItems.id, cursor));
    if (!folder || folder.kind !== "folder" || folder.state !== "complete") {
      throw new DriveError("The destination folder is no longer available.");
    }
    path.push(folder);
    cursor = folder.parentId;
  }
  return path.reverse();
}

export function treeDepth(row: DriveRow, byId: Map<string, DriveRow>): number {
  let depth = row.kind === "folder" ? 1 : 0;
  let cursor = row.parentId;
  const seen = new Set([row.id]);
  while (cursor && byId.has(cursor)) {
    if (seen.has(cursor)) throw new DriveError("This folder tree is unavailable.");
    seen.add(cursor);
    const parent = byId.get(cursor)!;
    if (parent.kind !== "folder") throw new DriveError("This folder tree is unavailable.");
    depth += 1;
    cursor = parent.parentId;
  }
  return depth;
}

export function assertMoveDepth(tree: DriveTree, destinationPath: DriveRow[]): void {
  if (destinationPath.some((folder) => tree.byId.has(folder.id))) {
    throw new DriveError("A folder cannot be moved into itself or one of its subfolders.");
  }
  for (const row of tree.rows) {
    if (treeDepth(row, tree.byId) + destinationPath.length > MAX_FOLDER_DEPTH) {
      throw new DriveError("This move would nest folders more than 64 levels deep.");
    }
  }
}

export function childFirst(rows: DriveRow[]): DriveRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const depth = new Map(rows.map((row) => [row.id, treeDepth(row, byId) + (row.kind === "file" ? 1 : 0)]));
  return [...rows].sort((a, b) => depth.get(b.id)! - depth.get(a.id)! || a.id.localeCompare(b.id));
}

/** Restore only the selected trash group, never independently trashed descendants. */
export function restoreRows(tree: DriveTree, selectedIds: string[]): DriveRow[] {
  const selected = new Set(selectedIds);
  const restored = new Set<string>();
  const rows: DriveRow[] = [];
  for (const row of childFirst(tree.rows).reverse()) {
    if (row.state !== "complete" || !row.trashedAt) continue;
    const parent = row.parentId ? tree.byId.get(row.parentId) : undefined;
    if (selected.has(row.id) || (parent && restored.has(parent.id) && row.trashRootId === parent.trashRootId)) {
      restored.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}
