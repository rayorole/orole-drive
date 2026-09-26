import "server-only";

import { eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { tryItemsAccess, withDriveTransaction } from "@/lib/drive-access";
import type { DriveContext } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { driveItems } from "@/lib/drive-schema";
import type { DriveRow } from "@/lib/drive-schema";
import { downloadBoundedBytes } from "@/lib/pdf-text";
import { searchMetadataEligibility } from "@/lib/search-eligibility";
import { loadSearchNodes } from "@/lib/search-index";
import { signDownload } from "@/lib/storage";

export const CHAT_IMAGE_MAX_BYTES = 10 * 1_048_576;
const imageTypes: Record<string, true> = { "image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true, "image/avif": true };

/** Rechecks session, ACL and every ancestor's AI exclusion, including unlocked protected folders. */
export async function requireChatFile(ctx: DriveContext, itemId: string): Promise<DriveRow> {
  const id = z.uuid().parse(itemId);
  return withDriveTransaction("read", async (tx) => {
    const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id));
    if (!row || row.kind !== "file" || row.state !== "complete") throw new DriveError("That file is not available.");
    const access = await tryItemsAccess(tx, ctx, [id], { permission: "read" });
    const nodes = await loadSearchNodes(tx, [id]);
    if (!access.get(id) || !searchMetadataEligibility(nodes, id).eligible) throw new DriveError("That file is not available.");
    return row;
  });
}

/** Storage URLs are never returned to the model or persisted in chat payloads. */
export async function loadChatFileBytes(row: DriveRow, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (row.size > maxBytes) throw new DriveError(`This file exceeds the ${Math.floor(maxBytes / 1_048_576)} MB safe reading limit.`);
  if (!row.size) return new Uint8Array();
  const url = await signDownload(row, true);
  if (!url) throw new DriveError("That file is not available.");
  const bytes = await downloadBoundedBytes(url, maxBytes, signal);
  if (bytes.length !== row.size) throw new DriveError("The file changed while it was being read. Please try again.");
  return bytes;
}

/** Shared preview/model path: actual pixels, bounded dimensions, metadata stripped, never SVG/HTML. */
export async function prepareChatImage(bytes: Uint8Array, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (bytes.length > CHAT_IMAGE_MAX_BYTES) throw new DriveError("This image exceeds the 10 MB reading limit.");
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false });
    const metadata = await image.metadata();
    if (!metadata.format || !["jpeg", "png", "gif", "webp", "avif", "heif"].includes(metadata.format)) throw new Error("Unsupported raster format");
    const data = await image.rotate().resize(1_568, 1_568, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
    signal.throwIfAborted();
    return data;
  } catch {
    signal.throwIfAborted();
    throw new DriveError("This image cannot be decoded safely. Supported images are JPEG, PNG, GIF, WebP and AVIF.");
  }
}

export async function loadChatImage(ctx: DriveContext, itemId: string, signal: AbortSignal) {
  const row = await requireChatFile(ctx, itemId);
  if (!imageTypes[row.mimeType ?? ""]) throw new DriveError("Choose a JPEG, PNG, GIF, WebP or AVIF image.");
  const bytes = await loadChatFileBytes(row, CHAT_IMAGE_MAX_BYTES, signal);
  const data = await prepareChatImage(bytes, signal);
  const current = await requireChatFile(ctx, itemId);
  if (current.etag !== row.etag || current.objectKey !== row.objectKey) throw new DriveError("The image changed while it was being read. Please try again.");
  return { row: current, data, mediaType: "image/jpeg" as const };
}
