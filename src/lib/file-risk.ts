import "server-only";

import { experimental_evaluate as evaluate } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import type { DriveRow } from "@/lib/drive-schema";
import { driveItems } from "@/lib/drive-schema";
import { fileRiskSignals, riskLevel, type FileRiskSignal } from "@/lib/file-risk-signals";
import { signDownload } from "@/lib/storage";
import { getFileReportByHash, hashRemoteFile, MAX_AUTO_HASH_BYTES, virusTotalApiKey } from "@/lib/virustotal";
import { driveFileRisks, driveVirusScans } from "@/lib/virustotal-schema";

const JEV_MODEL = "typesafe-ai/jev";

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Asks Jev how risky a file looks. Only metadata leaves the drive: the name, extension, declared
 * type, size and the local signals. File contents are never sent. Null when the gateway isn't
 * configured or doesn't answer; the local signals still apply.
 */
async function scoreWithJev(row: Pick<DriveRow, "name" | "mimeType" | "size">, signals: FileRiskSignal[]) {
  if (!process.env.AI_GATEWAY_API_KEY?.trim() && !process.env.VERCEL_OIDC_TOKEN) return null;
  try {
    const result = await evaluate({
      model: JEV_MODEL,
      state: {
        fileName: row.name,
        extension: extensionOf(row.name),
        declaredMimeType: row.mimeType ?? "unknown",
        sizeBytes: row.size,
        localSignals: signals,
        context: "A file uploaded to a private family cloud drive. Only its metadata is available, not its contents.",
      },
      questions: {
        risk: {
          type: "score",
          instructions: "How likely is this file to be malware or a malicious lure, judging only by its name, extension and declared type?",
          criteria: [
            "benign: an ordinary document, photo, video, audio file or data file",
            "unusual: an uncommon type, but likely harmless",
            "risky: can run code on the computer that opens it, such as a program, script, macro document or disk image",
            "very likely malicious: disguised as a harmless file type, or strong malware indicators",
          ],
        },
        disguised: {
          type: "boolean",
          instructions: "Is this file pretending to be a different, more harmless file type than it really is?",
        },
      },
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(10_000),
    });
    return { score: result.answers.risk.score, disguised: result.answers.disguised.probability };
  } catch (error) {
    console.error("Jev file risk scoring failed", error);
    return null;
  }
}

/** Scores and stores one file's risk. Returns the stored level. */
export async function assessFileRisk(row: Pick<DriveRow, "id" | "name" | "mimeType" | "size">) {
  const signals = fileRiskSignals(row.name, row.mimeType);
  const jev = await scoreWithJev(row, signals);
  const level = riskLevel(signals, jev?.score ?? null, jev?.disguised ?? null);
  const values = { level, score: jev?.score ?? null, disguisedProbability: jev?.disguised ?? null, signals, checkedAt: new Date() };
  await getDb().insert(driveFileRisks).values({ itemId: row.id, ...values })
    .onConflictDoUpdate({ target: driveFileRisks.itemId, set: values });
  return level;
}

/**
 * The priority lane: risky files get a VirusTotal hash lookup straight away, without waiting for
 * someone to open them. Only the SHA-256 is sent; uploading contents still needs a person's consent.
 */
async function lookUpByHash(row: DriveRow) {
  if (!virusTotalApiKey() || row.size > MAX_AUTO_HASH_BYTES) return;
  const [existing] = await getDb().select({ id: driveVirusScans.itemId }).from(driveVirusScans).where(eq(driveVirusScans.itemId, row.id)).limit(1);
  if (existing) return;
  const url = await signDownload(row, false, 120);
  const sha256 = url ? await hashRemoteFile(url, row.size) : null;
  if (!sha256) return;
  const report = await getFileReportByHash(sha256);
  await getDb().insert(driveVirusScans).values({
    itemId: row.id, sha256, status: report?.status ?? "unknown", statsJson: report?.statsJson ?? null, permalink: report?.permalink ?? null,
  }).onConflictDoNothing();
}

/**
 * Background job for new uploads and files that were never assessed. Files are assessed one at a
 * time, and the risky ones are looked up on VirusTotal before any lower-risk file.
 */
export async function prioritizeScans(ids: string[]) {
  if (!ids.length) return;
  const rows = await getDb().select().from(driveItems).where(and(inArray(driveItems.id, ids), eq(driveItems.kind, "file"), eq(driveItems.state, "complete")));
  const risky: DriveRow[] = [];
  for (const row of rows) {
    try {
      if ((await assessFileRisk(row)) === "high") risky.push(row);
    } catch (error) {
      console.error(`Could not assess file risk for ${row.id}`, error);
    }
  }
  for (const row of risky) {
    await lookUpByHash(row).catch((error) => console.error(`Priority hash lookup failed for ${row.id}`, error));
  }
}
