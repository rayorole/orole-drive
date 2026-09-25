"use server";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { assertItemAccess, driveAction, tryItemsAccess, withDriveTransaction } from "@/lib/drive-access";
import { driveItems } from "@/lib/drive-schema";
import type { ActionResult } from "@/lib/drive-types";
import { prepareThumbnail } from "@/lib/drive-thumbnails";
import { signThumbnail } from "@/lib/storage";
import { DriveError } from "@/lib/drive-errors";

export async function getThumbnailUrl(id: string): Promise<ActionResult<{ url: string | null }>> {
  return driveAction(async (context) => {
    id = z.uuid("Choose a valid file.").parse(id);
    const snapshot = await withDriveTransaction("read", async (tx) => {
      const [row] = await tx.select().from(driveItems).where(and(eq(driveItems.id, id), eq(driveItems.kind, "file"), eq(driveItems.state, "complete")));
      if (!row) throw new DriveError("This file is no longer available.");
      await assertItemAccess(tx, context, row, { permission: "read" });
      return row;
    });
    const key = await prepareThumbnail(snapshot);
    return withDriveTransaction("read", async (tx) => {
      const [current] = await tx.select().from(driveItems).where(eq(driveItems.id, id));
      if (!current) throw new DriveError("This file is no longer available.");
      await assertItemAccess(tx, context, current, { permission: "read" });
      return { url: key && current.objectKey === snapshot.objectKey && current.etag === snapshot.etag ? await signThumbnail(key) : null };
    });
  }, "read");
}

/** Passive grids do not disclose missing/inaccessible IDs or open password dialogs. */
export async function getThumbnailUrls(ids: string[]): Promise<ActionResult<Record<string, { url: string | null }>>> {
  return driveAction(async (context) => {
    ids = [...new Set(z.array(z.uuid()).max(40).parse(ids))];
    const result: Record<string, { url: string | null }> = Object.fromEntries(ids.map((id) => [id, { url: null }]));
    const snapshots = await withDriveTransaction("read", async (tx) => {
      const access = await tryItemsAccess(tx, context, ids, { permission: "read" });
      const allowed = ids.filter((id) => access.get(id));
      return allowed.length ? tx.select().from(driveItems).where(and(inArray(driveItems.id, allowed), eq(driveItems.kind, "file"), eq(driveItems.state, "complete"))) : [];
    });
    const prepared = await Promise.all(snapshots.map(async (row) => ({ row, key: await prepareThumbnail(row).catch(() => null) })));
    await withDriveTransaction("read", async (tx) => {
      const access = await tryItemsAccess(tx, context, ids, { permission: "read" });
      const rows = ids.length ? await tx.select().from(driveItems).where(inArray(driveItems.id, ids)) : [];
      const current = new Map(rows.map((row) => [row.id, row]));
      for (const { row, key } of prepared) {
        const live = current.get(row.id);
        if (key && access.get(row.id) && live?.objectKey === row.objectKey && live.etag === row.etag) result[row.id] = { url: await signThumbnail(key) };
      }
    });
    return result;
  }, "read");
}
