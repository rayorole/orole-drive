import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import type { DriveContext, DriveTransaction } from "@/lib/drive-access";
import { assertItemAccess, assertItemsAccess, withDriveTransaction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { driveActivity, driveFavorites, driveItems } from "@/lib/drive-schema";
import type { DriveRow } from "@/lib/drive-schema";
import type { DriveFolderColor } from "@/lib/drive-types";

export function normalizeTags(tags: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().slice(0, 32);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
    if (normalized.length >= 20) break;
  }
  return normalized;
}

async function requireItem(tx: DriveTransaction, ctx: DriveContext, id: string, options: { allowTrashed?: boolean } = {}): Promise<DriveRow> {
  const [row] = await tx.select().from(driveItems).where(and(eq(driveItems.id, id), eq(driveItems.state, "complete")));
  if (!row) throw new DriveError("This file or folder is no longer available.");
  await assertItemAccess(tx, ctx, row, options);
  return row;
}

export async function toggleDriveFavorite(ctx: DriveContext, id: string): Promise<{ favorited: boolean }> {
  return withDriveTransaction("write", async (tx) => {
    const row = await requireItem(tx, ctx, id, { allowTrashed: true });
    const [existing] = await tx.select().from(driveFavorites).where(and(eq(driveFavorites.userId, ctx.userId), eq(driveFavorites.itemId, row.id)));
    if (existing) {
      await tx.delete(driveFavorites).where(and(eq(driveFavorites.userId, ctx.userId), eq(driveFavorites.itemId, row.id)));
      return { favorited: false };
    }
    await tx.insert(driveFavorites).values({ userId: ctx.userId, itemId: row.id }).onConflictDoNothing();
    return { favorited: true };
  });
}

/** Sets (not toggles) favorites, so a mixed selection ends up in one consistent state. */
export async function setDriveFavorites(ctx: DriveContext, ids: string[], favorited: boolean): Promise<void> {
  await withDriveTransaction("write", async (tx) => {
    const rows = await tx.select().from(driveItems).where(and(inArray(driveItems.id, ids), eq(driveItems.state, "complete")));
    if (rows.length !== ids.length) throw new DriveError("Some of these files or folders are no longer available.");
    await assertItemsAccess(tx, ctx, rows, { allowTrashed: true });
    if (favorited) await tx.insert(driveFavorites).values(ids.map((itemId) => ({ userId: ctx.userId, itemId }))).onConflictDoNothing();
    else await tx.delete(driveFavorites).where(and(eq(driveFavorites.userId, ctx.userId), inArray(driveFavorites.itemId, ids)));
  });
}

export async function recordDriveOpened(ctx: DriveContext, id: string): Promise<void> {
  await withDriveTransaction("write", async (tx) => {
    const row = await requireItem(tx, ctx, id, { allowTrashed: true });
    await tx.insert(driveActivity).values({ userId: ctx.userId, itemId: row.id, accessedAt: new Date() })
      .onConflictDoUpdate({ target: [driveActivity.userId, driveActivity.itemId], set: { accessedAt: new Date() } });
  });
}

export async function setDriveItemTags(ctx: DriveContext, id: string, tags: string[]): Promise<void> {
  const normalized = normalizeTags(tags);
  await withDriveTransaction("write", async (tx) => {
    const row = await requireItem(tx, ctx, id);
    await tx.update(driveItems).set({ tags: normalized, updatedAt: new Date() }).where(eq(driveItems.id, row.id));
  });
}

export async function setDriveItemDescription(ctx: DriveContext, id: string, description: string): Promise<void> {
  await withDriveTransaction("write", async (tx) => {
    const row = await requireItem(tx, ctx, id);
    await tx.update(driveItems).set({ description, updatedAt: new Date() }).where(eq(driveItems.id, row.id));
  });
}

export async function setDriveFolderColor(ctx: DriveContext, id: string, color: DriveFolderColor | null): Promise<void> {
  await withDriveTransaction("write", async (tx) => {
    const row = await requireItem(tx, ctx, id);
    if (row.kind !== "folder") throw new DriveError("Only folders can have a color.");
    await tx.update(driveItems).set({ folderColor: color, updatedAt: new Date() }).where(eq(driveItems.id, row.id));
  });
}
