"use server";

import type { DriveContext } from "@/lib/drive-access";
import type { ActionResult, DriveItem, DriveNameConflict, ResumableUpload, UploadResolution, UploadTicket } from "@/lib/drive-types";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { assertItemAccess, driveAction, withDriveTransaction } from "@/lib/drive-access";
import { idSchema, nameSchema, parentSchema, uploadKeySchema, uploadResolutionSchema } from "@/lib/drive-input";
import { DriveError } from "@/lib/drive-errors";
import { driveItems } from "@/lib/drive-schema";
import { destinationSiblings, findConflicts } from "@/lib/name-conflicts";
import { listUploadedParts, signUpload } from "@/lib/storage";
import { ensureUploadFolder, uploadDestination } from "@/lib/uploads";

/** Unfinished uploads this member started (on any device) that can still finish before the 24-hour cleanup. */
function resumableUploads(ctx: DriveContext) {
  return and(
    eq(driveItems.createdBy, ctx.userId),
    eq(driveItems.kind, "file"),
    eq(driveItems.state, "pending"),
    isNull(driveItems.trashedAt),
    isNull(driveItems.deletionStartedAt),
    gt(driveItems.createdAt, sql`now() - interval '24 hours'`),
  );
}

/** Which of these files would clash with names already in the folder, so one prompt can cover a whole batch. */
export async function findUploadConflicts(input: { parentId?: string | null; files: { key: string; name: string }[] }): Promise<ActionResult<DriveNameConflict[]>> {
  return driveAction(async (ctx) => {
    const { parentId, files } = z.object({
      parentId: parentSchema,
      files: z.array(z.object({ key: uploadKeySchema, name: z.string().max(1024) })).max(1000, "Check up to 1,000 files at a time."),
    }).parse(input);
    return withDriveTransaction("read", async (tx) => {
      await uploadDestination(tx, ctx, parentId);
      return findConflicts(files.map((file) => ({ id: file.key, name: file.name.trim().normalize(), kind: "file" })), await destinationSiblings(tx, parentId));
    });
  }, "read");
}

/** Folder for a folder upload: merges into an existing folder with the same name instead of creating a duplicate. */
export async function ensureFolder(input: { name: string; parentId?: string | null; key?: string; resolution?: UploadResolution }): Promise<ActionResult<{ folder: DriveItem; created: boolean }>> {
  return driveAction(async (ctx) => {
    const { name, parentId, key, resolution } = z.object({
      name: nameSchema, parentId: parentSchema, key: uploadKeySchema.optional(), resolution: uploadResolutionSchema.optional(),
    }).parse(input);
    return ensureUploadFolder(ctx, { key: key ?? name, name, parentId, resolution });
  });
}

export async function listResumableUploads(): Promise<ActionResult<ResumableUpload[]>> {
  return driveAction(async (ctx) => withDriveTransaction("read", async (tx) => {
    const parent = alias(driveItems, "parent");
    const replaced = alias(driveItems, "replaced");
    const rows = await tx.select({ upload: driveItems, parentName: parent.name }).from(driveItems)
      .leftJoin(parent, eq(parent.id, driveItems.parentId))
      .leftJoin(replaced, eq(replaced.id, driveItems.replacesId))
      .where(and(
        resumableUploads(ctx),
        or(isNull(driveItems.replacesId), and(eq(replaced.state, "complete"), isNull(replaced.trashedAt), isNull(replaced.deletionStartedAt))),
      ))
      .orderBy(asc(driveItems.createdAt));
    const uploads: ResumableUpload[] = [];
    for (const { upload, parentName } of rows) {
      try {
        await assertItemAccess(tx, ctx, upload);
      } catch (error) {
        // Destinations since trashed, removed or locked are left for the scheduled cleanup.
        if (error instanceof DriveError) continue;
        throw error;
      }
      uploads.push({
        id: upload.id, name: upload.name, size: upload.size, mimeType: upload.mimeType ?? "application/octet-stream",
        parentId: upload.parentId, parentName, replaces: upload.replacesId !== null, multipart: upload.multipartUploadId !== null,
        createdAt: upload.createdAt.toISOString(),
      });
    }
    return uploads;
  }), "read");
}

/** A fresh ticket for one of this member's unfinished uploads; multipart tickets skip the parts R2 already has. */
export async function resumeUpload(id: string): Promise<ActionResult<UploadTicket>> {
  return driveAction(async (ctx) => {
    id = idSchema.parse(id);
    return withDriveTransaction("read", async (tx) => {
      const [row] = await tx.select().from(driveItems).where(and(eq(driveItems.id, id), resumableUploads(ctx)));
      if (!row) throw new DriveError("This upload can no longer be resumed. Upload the file again.");
      await assertItemAccess(tx, ctx, row);
      return signUpload(row, await listUploadedParts(row));
    });
  });
}
