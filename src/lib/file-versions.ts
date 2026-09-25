import "server-only";

import type { DriveTransaction } from "@/lib/drive-access";
import type { DriveFileVersionRow, DriveRow } from "@/lib/drive-schema";
import type { DriveItem } from "@/lib/drive-types";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { DriveError } from "@/lib/drive-errors";
import { driveFileVersions, driveItems } from "@/lib/drive-schema";
import { prioritizeScans } from "@/lib/file-risk";
import { cleanupVersion, queueVersionCleanup, removeThumbnail } from "@/lib/storage";
import { driveFileRisks, driveVirusScans } from "@/lib/virustotal-schema";

/** Earlier versions kept per file; a replacement beyond this drops the oldest. */
export const MAX_FILE_VERSIONS = 20;

export type FileContent = { objectKey: string; size: number; mimeType: string; etag: string; createdBy: string | null };
/** `version` holds the previous content; `pruned` are versions dropped by the retention limit. */
export type ContentReplacement = { file: DriveRow; version: DriveFileVersionRow; pruned: DriveFileVersionRow[] };

/**
 * Makes `content` the file's current content inside the caller's write transaction; the previous content becomes a
 * version. `createdBy` follows the content, so each version names who uploaded it and its bytes count toward that
 * member's storage. Ownership and sharing belong to the file and never follow the content. Scan results and risk
 * scores described the old bytes and are dropped. No drive_items row may still hold `content.objectKey`.
 * Pass the result to `afterContentChange` once the transaction commits.
 */
export async function replaceFileContent(tx: DriveTransaction, file: DriveRow, content: FileContent): Promise<ContentReplacement> {
  if (file.kind !== "file" || file.state !== "complete" || !file.objectKey || !file.mimeType || !file.etag) {
    throw new DriveError("This file is no longer available.");
  }
  const [version] = await tx.insert(driveFileVersions).values({
    id: randomUUID(), itemId: file.id, objectKey: file.objectKey, size: file.size, mimeType: file.mimeType, etag: file.etag,
    createdBy: file.createdBy, createdAt: file.updatedAt,
  }).returning();
  const { objectKey, size, mimeType, etag, createdBy } = content;
  const [updated] = await tx.update(driveItems).set({ objectKey, size, mimeType, etag, createdBy, updatedAt: new Date() }).where(eq(driveItems.id, file.id)).returning();
  await tx.delete(driveVirusScans).where(eq(driveVirusScans.itemId, file.id));
  await tx.delete(driveFileRisks).where(eq(driveFileRisks.itemId, file.id));
  const pruned = await tx.select().from(driveFileVersions).where(eq(driveFileVersions.itemId, file.id))
    .orderBy(desc(driveFileVersions.replacedAt), desc(driveFileVersions.createdAt)).offset(MAX_FILE_VERSIONS);
  if (pruned.length) {
    for (const version of pruned) await queueVersionCleanup(tx, version);
    await tx.delete(driveFileVersions).where(inArray(driveFileVersions.id, pruned.map((row) => row.id)));
  }
  return { file: updated, version, pruned };
}

/**
 * After a content change commits: drops the legacy thumbnail, attempts journaled
 * version cleanup, and re-assesses unprotected content for scanning.
 */
export async function afterContentChange(file: DriveItem, pruned: DriveFileVersionRow[]): Promise<void> {
  await Promise.allSettled([removeThumbnail(file.id), ...pruned.map((version) => cleanupVersion(version))]);
  if (!file.isProtected) after(() => prioritizeScans([file.id]));
}
