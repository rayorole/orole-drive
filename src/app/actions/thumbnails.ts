"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { assertItemAccess, driveAction, withDriveTransaction } from "@/lib/drive-access";
import { driveItems } from "@/lib/drive-schema";
import type { ActionResult } from "@/lib/drive-types";
import { getThumbnailForRow } from "@/lib/drive-thumbnails";
import { DriveError } from "@/lib/drive-errors";

export async function getThumbnailUrl(id: string): Promise<ActionResult<{ url: string | null }>> {
  return driveAction(async (context) => {
    id = z.uuid("Choose a valid file.").parse(id);
    return withDriveTransaction("read", async (tx) => {
      const [row] = await tx.select().from(driveItems).where(and(
        eq(driveItems.id, id), eq(driveItems.kind, "file"), eq(driveItems.state, "complete"),
      )).limit(1);
      if (!row) throw new DriveError("This file is no longer available.");
      await assertItemAccess(tx, context, row, { permission: "read" });
      // Keep authorization and signing in the hierarchy read lock, including derivative generation.
      return { url: await getThumbnailForRow(row) };
    });
  }, "read");
}
