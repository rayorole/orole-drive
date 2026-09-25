"use server";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertItemAccess, canAccessPublic, driveAction, withDriveTransaction } from "@/lib/drive-access";
import type { DriveTransaction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { driveItems } from "@/lib/drive-schema";
import type { DriveRow } from "@/lib/drive-schema";
import type { ActionResult } from "@/lib/drive-types";
import { signDownload } from "@/lib/storage";
import { getAnalysisReport, getFileReportByHash, hashRemoteFile, MAX_AUTO_HASH_BYTES, MAX_VT_SUBMISSION_BYTES, submitFileForScanning, virusTotalApiKey } from "@/lib/virustotal";
import { driveVirusScans } from "@/lib/virustotal-schema";
import type { DriveVirusScanRow } from "@/lib/virustotal-schema";

export type FileScanStatus = {
  configured: boolean;
  status: "unknown" | "pending" | "clean" | "suspicious" | "malicious";
  scannedAt: string | null;
  permalink: string | null;
  eligibleForSubmission: boolean;
  submissionSizeLimit: number;
};

const idSchema = z.uuid("Choose a valid file.");
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "That share link is invalid.");

function toStatus(scan: DriveVirusScanRow | null, sizeBytes: number, allowSubmission = true): FileScanStatus {
  const configured = virusTotalApiKey() !== null;
  return {
    configured,
    status: scan?.status ?? "unknown",
    scannedAt: scan?.scannedAt.toISOString() ?? null,
    permalink: scan?.permalink ?? null,
    eligibleForSubmission: allowSubmission && configured && (scan?.status ?? "unknown") === "unknown" && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 && sizeBytes <= MAX_VT_SUBMISSION_BYTES,
    submissionSizeLimit: MAX_VT_SUBMISSION_BYTES,
  };
}

/** Loads the persisted scan, refreshing a pending analysis or opportunistically auto-hashing a small unscanned file. */
async function ensureScan(tx: DriveTransaction, row: DriveRow): Promise<DriveVirusScanRow | null> {
  const [existing] = await tx.select().from(driveVirusScans).where(eq(driveVirusScans.itemId, row.id)).limit(1);
  if (!virusTotalApiKey()) return existing ?? null;
  if (existing) {
    const refreshAfter = existing.status === "pending" || existing.status === "unknown" ? 30_000 : 24 * 60 * 60_000;
    if (Date.now() - existing.scannedAt.getTime() < refreshAfter) return existing;
    const report = existing.status === "pending" && existing.analysisId
      ? await getAnalysisReport(existing.analysisId, existing.sha256)
      : await getFileReportByHash(existing.sha256);
    if (!report) return existing;
    const [updated] = await tx.update(driveVirusScans).set({
      status: report.status, statsJson: report.statsJson, permalink: report.permalink,
      analysisId: report.status === "pending" ? existing.analysisId : null, scannedAt: new Date(),
    }).where(and(eq(driveVirusScans.itemId, row.id), eq(driveVirusScans.scannedAt, existing.scannedAt))).returning();
    return updated ?? existing;
  }
  if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_AUTO_HASH_BYTES) return null;
  const url = await signDownload(row, false, 120);
  if (!url) return null;
  const sha256 = await hashRemoteFile(url, row.size);
  if (!sha256) return null;
  const report = await getFileReportByHash(sha256);
  const [inserted] = await tx.insert(driveVirusScans).values({
    itemId: row.id, sha256, status: report?.status ?? "unknown", statsJson: report?.statsJson ?? null, permalink: report?.permalink ?? null,
  }).onConflictDoNothing().returning();
  if (inserted) return inserted;
  const [concurrent] = await tx.select().from(driveVirusScans).where(eq(driveVirusScans.itemId, row.id)).limit(1);
  return concurrent ?? null;
}

async function loadScannableFile(tx: DriveTransaction, id: string): Promise<DriveRow> {
  const [row] = await tx.select().from(driveItems).where(and(
    eq(driveItems.id, id), eq(driveItems.kind, "file"), eq(driveItems.state, "complete"),
  )).limit(1);
  if (!row) throw new DriveError("This file is no longer available.");
  return row;
}

export async function getFileScanStatus(id: string): Promise<ActionResult<FileScanStatus>> {
  return driveAction(async (ctx) => {
    const fileId = idSchema.parse(id);
    return withDriveTransaction("write", async (tx) => {
      const row = await loadScannableFile(tx, fileId);
      await assertItemAccess(tx, ctx, row);
      const scan = await ensureScan(tx, row);
      return toStatus(scan, row.size);
    });
  }, "read");
}

export async function submitFileScan(id: string, consent: boolean): Promise<ActionResult<FileScanStatus>> {
  return driveAction(async (ctx) => {
    const fileId = idSchema.parse(id);
    if (consent !== true) throw new DriveError("Confirm that VirusTotal may distribute this file to its security partners before submitting.");
    const row = await withDriveTransaction("read", async (tx) => {
      const item = await loadScannableFile(tx, fileId);
      await assertItemAccess(tx, ctx, item);
      return item;
    });
    if (!row.etag) throw new DriveError("This file is not available for scanning.");
    if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_VT_SUBMISSION_BYTES) {
      throw new DriveError("VirusTotal submissions are limited to 650 MB. This file was not downloaded or sent.");
    }
    const cached = await withDriveTransaction("read", async (tx) => {
      const [scan] = await tx.select().from(driveVirusScans).where(eq(driveVirusScans.itemId, row.id)).limit(1);
      return scan;
    });
    if (cached && cached.status !== "unknown") return toStatus(cached, row.size);
    const url = await signDownload(row, false, 120);
    if (!url) throw new DriveError("This file is not available for scanning.");
    const submission = await submitFileForScanning(url, row.size, row.name);
    if (!submission) throw new DriveError("VirusTotal could not accept this file right now. Try again in a moment.");
    return withDriveTransaction("write", async (tx) => {
      const current = await loadScannableFile(tx, fileId);
      await assertItemAccess(tx, ctx, current);
      if (current.etag !== row.etag || current.size !== row.size) throw new DriveError("The file changed during submission. Reopen its details.");
      const [scan] = await tx.insert(driveVirusScans).values({
        itemId: row.id, sha256: submission.sha256, status: submission.report.status,
        analysisId: submission.analysisId,
        statsJson: submission.report.statsJson, permalink: submission.report.permalink,
      }).onConflictDoUpdate({
        target: driveVirusScans.itemId,
        set: {
          sha256: submission.sha256, status: submission.report.status,
          analysisId: submission.analysisId,
          statsJson: submission.report.statsJson, permalink: submission.report.permalink, scannedAt: sql`clock_timestamp()`,
        },
      }).returning();
      return toStatus(scan ?? null, row.size);
    });
  }, "write");
}

/** Duplicates getPublicFile's validation constraints rather than importing it, per the share-extras contract. */
async function loadPublicScannableFile(tx: DriveTransaction, token: string): Promise<DriveRow> {
  const [row] = await tx.select().from(driveItems).where(and(
    eq(driveItems.publicToken, token),
    eq(driveItems.kind, "file"),
    eq(driveItems.state, "complete"),
    sql`(${driveItems.publicExpiresAt} is null or ${driveItems.publicExpiresAt} > clock_timestamp())`,
  )).limit(1).for("share");
  if (!row || !(await canAccessPublic(tx, row))) throw new DriveError("This file is no longer shared. Ask the owner for a new link.");
  return row;
}

export async function getPublicFileScanStatus(token: string): Promise<ActionResult<FileScanStatus>> {
  try {
    const shareToken = tokenSchema.parse(token);
    const status = await withDriveTransaction("read", async (tx) => {
      const row = await loadPublicScannableFile(tx, shareToken);
      const [scan] = await tx.select().from(driveVirusScans).where(eq(driveVirusScans.itemId, row.id)).limit(1);
      return toStatus(scan ?? null, row.size, false);
    });
    return { success: true, data: status };
  } catch (error) {
    if (error instanceof DriveError || error instanceof z.ZodError) {
      return { success: false, error: error instanceof DriveError ? error.message : "That share link is invalid." };
    }
    return { success: false, error: "The scan status could not be reached. Try again in a moment." };
  }
}

