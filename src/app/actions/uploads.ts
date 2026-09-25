"use server";

import type { DriveContext } from "@/lib/drive-access";
import type { ActionResult, ResumableUpload, UploadTicket } from "@/lib/drive-types";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { driveAction, withDriveTransaction } from "@/lib/drive-access";
import { idSchema, mimeSchema, nameSchema, parentSchema, uploadKeySchema, uploadResolutionSchema } from "@/lib/drive-input";
import { DriveError } from "@/lib/drive-errors";
import { driveItems } from "@/lib/drive-schema";
import { MAX_UPLOAD_BYTES } from "@/lib/drive-types";
import { assertUploadAccess, ensureUploadFolders, startUpload, uploadTicket } from "@/lib/uploads";
import type { UploadFolderRequest, UploadFolderResult, UploadRequest } from "@/lib/uploads";

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

/** Bounded reservation batches return each actual reservation's ActionResult, including name conflicts. */
export async function beginUploads(files: UploadRequest[]): Promise<ActionResult<{ key: string; result: ActionResult<UploadTicket> }[]>> {
  return driveAction(async (ctx) => {
    const requestSchema = z.object({
      key: uploadKeySchema, name: nameSchema, size: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
      mimeType: mimeSchema, parentId: parentSchema, resolution: uploadResolutionSchema.optional(),
    });
    const requests = z.array(z.object({ key: uploadKeySchema }).passthrough()).min(1).max(20).parse(files);
    const results: { key: string; result: ActionResult<UploadTicket> }[] = [];
    for (const request of requests) {
      results.push({ key: request.key, result: await driveAction(() => startUpload(ctx, requestSchema.parse(request))) });
    }
    return results;
  });
}

/** Parents in the same chunk are referred to by key; earlier chunks use their returned folder IDs. */
export async function ensureFolders(input: UploadFolderRequest[]): Promise<ActionResult<UploadFolderResult[]>> {
  return driveAction(async (ctx) => {
    const requests = z.array(z.object({
      name: nameSchema, parentId: parentSchema, key: uploadKeySchema, parentKey: uploadKeySchema.optional(), resolution: uploadResolutionSchema.optional(),
    })).min(1).max(32).refine((rows) => new Set(rows.map((row) => row.key)).size === rows.length, "Choose distinct folder keys.").parse(input);
    return ensureUploadFolders(ctx, requests);
  });
}

export async function listResumableUploads(): Promise<ActionResult<ResumableUpload[]>> {
  return driveAction(async (ctx) => withDriveTransaction("read", async (tx) => {
    const parent = alias(driveItems, "parent");
    const replaced = alias(driveItems, "replaced");
    const rows = await tx.select({ upload: driveItems, parentName: parent.name, replacement: replaced }).from(driveItems)
      .leftJoin(parent, eq(parent.id, driveItems.parentId))
      .leftJoin(replaced, eq(replaced.id, driveItems.replacesId))
      .where(and(
        resumableUploads(ctx),
        or(isNull(driveItems.replacesId), and(eq(replaced.state, "complete"), isNull(replaced.trashedAt), isNull(replaced.deletionStartedAt))),
      ))
      .orderBy(asc(driveItems.createdAt));
    const uploads: ResumableUpload[] = [];
    for (const { upload, parentName, replacement } of rows) {
      try {
        await assertUploadAccess(tx, ctx, upload);
        if (replacement) await assertUploadAccess(tx, ctx, replacement);
      } catch (error) {
        // Destinations or replacement targets no longer writable are left for the scheduled cleanup.
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
  return driveAction(async (ctx) => uploadTicket(ctx, idSchema.parse(id), true));
}
