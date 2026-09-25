import "server-only";

import { after } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { withDriveTransaction } from "@/lib/drive-access";
import type { DriveRow } from "@/lib/drive-schema";
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
export async function queueScanSubmission(row: DriveRow): Promise<boolean> {
  if (!canSubmitForScan(row)) return false;
  const queued = await withDriveTransaction("write", async (tx) => {
    const [placeholder] = await tx.insert(driveVirusScans).values({
      itemId: row.id, sha256: "", status: "pending", analysisId: null, statsJson: null, permalink: null,
    }).onConflictDoUpdate({
      target: driveVirusScans.itemId,
      set: { sha256: "", status: "pending", analysisId: null, statsJson: null, permalink: null, scannedAt: sql`clock_timestamp()` },
      // Only replace a lookup that found nothing; never a real result or a scan already in progress.
      setWhere: eq(driveVirusScans.status, "unknown"),
    }).returning();
    return Boolean(placeholder);
  });
  if (queued) after(() => runSubmission(row));
  return queued;
}

async function runSubmission(row: DriveRow) {
  const placeholder = and(eq(driveVirusScans.itemId, row.id), eq(driveVirusScans.sha256, ""), eq(driveVirusScans.status, "pending"));
  try {
    const url = await signDownload(row, false, 30 * 60);
    const submission = url ? await submitFileForScanning(url, row.size, row.name) : null;
    if (!submission) throw new Error("VirusTotal did not accept the file.");
    await withDriveTransaction("write", (tx) => tx.update(driveVirusScans).set({
      sha256: submission.sha256, status: submission.report.status, analysisId: submission.analysisId,
      statsJson: submission.report.statsJson, permalink: submission.report.permalink, scannedAt: sql`clock_timestamp()`,
    }).where(placeholder));
  } catch (error) {
    console.error(`Virus scan submission failed for ${row.id}`, error);
    // Drop the placeholder so the file reads as unscanned and can be submitted again.
    await withDriveTransaction("write", (tx) => tx.delete(driveVirusScans).where(placeholder)).catch(() => {});
  }
}
