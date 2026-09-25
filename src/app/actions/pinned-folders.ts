"use server";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { assertItemAccess, driveAction, getItemsAccess, visibleItemsCondition, withDriveTransaction } from "@/lib/drive-access";
import type { DriveContext, DriveTransaction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { idSchema } from "@/lib/drive-input";
import { driveItems, drivePinnedFolders } from "@/lib/drive-schema";
import type { ActionResult, DriveItem } from "@/lib/drive-types";
import { toDriveItem } from "@/lib/storage";

async function visiblePins(tx: DriveTransaction, ctx: DriveContext): Promise<DriveItem[]> {
  const rows = await tx.select({ item: driveItems }).from(drivePinnedFolders)
    .innerJoin(driveItems, eq(drivePinnedFolders.itemId, driveItems.id))
    .where(and(eq(drivePinnedFolders.userId, ctx.userId), eq(driveItems.kind, "folder"),
      eq(driveItems.state, "complete"), isNull(driveItems.trashedAt), isNull(driveItems.deletionStartedAt), visibleItemsCondition(ctx)))
    .orderBy(asc(sql`lower(${driveItems.name})`), asc(driveItems.id));
  const items = rows.map(({ item }) => item);
  const access = await getItemsAccess(tx, ctx, items);
  return items.map((item) => ({ ...toDriveItem(item), ...access.get(item.id)! }));
}

export async function listPinnedFolders(): Promise<ActionResult<DriveItem[]>> {
  return driveAction((ctx) => withDriveTransaction("read", (tx) => visiblePins(tx, ctx)), "read");
}

export async function setFolderPinned(id: string, pinned: boolean): Promise<ActionResult<DriveItem[]>> {
  return driveAction(async (ctx) => {
    const itemId = idSchema.parse(id);
    const pin = z.boolean().parse(pinned);
    return withDriveTransaction("write", async (tx) => {
      const [folder] = await tx.select().from(driveItems).where(eq(driveItems.id, itemId));
      if (!folder || folder.kind !== "folder" || folder.state !== "complete") throw new DriveError("Choose an available folder to pin to the sidebar.");
      // A visible locked folder can be pinned; its descendants require current session grants.
      await assertItemAccess(tx, ctx, folder, { includeSelf: false, permission: "read" });
      if (pin) await tx.insert(drivePinnedFolders).values({ userId: ctx.userId, itemId }).onConflictDoNothing();
      else await tx.delete(drivePinnedFolders).where(and(eq(drivePinnedFolders.userId, ctx.userId), eq(drivePinnedFolders.itemId, itemId)));
      return visiblePins(tx, ctx);
    });
  }, "read");
}
