import "server-only";

import { after } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { assertItemAccess, withDriveTransaction, type DriveContext, type DriveTransaction } from "@/lib/drive-access";
import { driveItems, type DriveRow } from "@/lib/drive-schema";
import { signDownload } from "@/lib/storage";
import { MAX_VT_SUBMISSION_BYTES, submitFileForScanning, virusTotalApiKey } from "@/lib/virustotal";
import { driveVirusScans } from "@/lib/virustotal-schema";
import type { DriveVirusScanRow } from "@/lib/virustotal-schema";

/** Upload plus VirusTotal's first response; a placeholder older than this is treated as a failed submission. */
export const SUBMISSION_TIMEOUT_MS = 15 * 60_000;

/**
 * A submission still streaming the file to VirusTotal: `pending` with no hash yet.
 * The real hash and analysis id are only known once the upload finishes.
 */
export function isSubmitting(scan: Pick<DriveVirusScanRow, "status" | "sha256" | "analysisId">) {
  return scan.status === "pending" && scan.sha256 === "" && scan.analysisId === null;
}

export function canSubmitForScan(row: Pick<DriveRow, "kind" | "state" | "size" | "etag">) {
  return virusTotalApiKey() !== null && row.kind === "file" && row.state === "complete" && Boolean(row.etag)
    && Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= MAX_VT_SUBMISSION_BYTES;
}

/**
 * Marks the file as being scanned and uploads it to VirusTotal after the response is sent.
 * Returns false when there's nothing to do: scanning is off, the file is too large, or it already has a result.
 */
export async function queueScanSubmission(row: DriveRow, ctx: DriveContext): Promise<boolean> {
  if (!canSubmitForScan(row)) return false;
  const queued = await withDriveTransaction("write", async (tx) => {
    if (!(await currentSubmissionFile(tx, ctx, row))) return null;
    const [placeholder] = await tx.insert(driveVirusScans).values({
      itemId: row.id, sha256: "", status: "pending", analysisId: null, statsJson: null, permalink: null,
    }).onConflictDoUpdate({
      target: driveVirusScans.itemId,
      set: { sha256: "", status: "pending", analysisId: null, statsJson: null, permalink: null, scannedAt: sql`clock_timestamp()` },
      // Only replace a lookup that found nothing; never a real result or a scan already in progress.
      setWhere: eq(driveVirusScans.status, "unknown"),
    }).returning();
    return placeholder ?? null;
  });
  if (queued) after(() => runSubmission(row, ctx, queued.scannedAt));
  return Boolean(queued);
}

async function currentSubmissionFile(tx: DriveTransaction, ctx: DriveContext, expected: DriveRow): Promise<DriveRow | null> {
  const [current] = await tx.select().from(driveItems).where(eq(driveItems.id, expected.id));
  if (!current || current.etag !== expected.etag || current.objectKey !== expected.objectKey || !canSubmitForScan(current)) return null;
  await assertItemAccess(tx, ctx, current, { permission: "manage" });
  return current;
}

async function runSubmission(row: DriveRow, ctx: DriveContext, queuedAt: Date) {
  const placeholder = and(
    eq(driveVirusScans.itemId, row.id), eq(driveVirusScans.sha256, ""), eq(driveVirusScans.status, "pending"),
    sql`date_trunc('milliseconds', ${driveVirusScans.scannedAt}) = ${queuedAt.toISOString()}::timestamptz`,
  );
  try {
    // Keep the current owner authorization and exact content stable until the external send finishes.
    await withDriveTransaction("read", async (tx) => {
      const current = await currentSubmissionFile(tx, ctx, row);
      if (!current) {
        await tx.delete(driveVirusScans).where(placeholder);
        return;
      }
      const [pending] = await tx.select({ id: driveVirusScans.itemId }).from(driveVirusScans).where(placeholder);
      if (!pending) return;
      const url = await signDownload(current, false, 30 * 60);
      const submission = url ? await submitFileForScanning(url, current.size, current.name) : null;
      if (!submission) throw new Error("VirusTotal did not accept the file.");
      await tx.update(driveVirusScans).set({
        sha256: submission.sha256, status: submission.report.status, analysisId: submission.analysisId,
        statsJson: submission.report.statsJson, permalink: submission.report.permalink, scannedAt: sql`clock_timestamp()`,
      }).where(placeholder);
    });
  } catch (error) {
    console.error(`Virus scan submission failed for ${row.id}`, error);
    // Drop the placeholder so the file reads as unscanned and can be submitted again.
    await withDriveTransaction("write", (tx) => tx.delete(driveVirusScans).where(placeholder)).catch(() => {});
  }
}
