import "server-only";

import sharp from "sharp";
import type { DriveRow } from "@/lib/drive-schema";
import { canThumbnail, THUMBNAIL_SOURCE_BYTES } from "@/lib/file-preview";
import { and, eq, isNull } from "drizzle-orm";
import { withDriveTransaction } from "@/lib/drive-access";
import { driveFileVersions, driveItems } from "@/lib/drive-schema";
import { contentThumbnailKey, readFileBytes, thumbnailExists, writeThumbnail } from "@/lib/storage";
import { withStorageObjectLock } from "@/lib/storage-work";

const pending = new Map<string, Promise<string | null>>();
const waiting: Array<() => void> = [];
let active = 0;

/** Produces an immutable-content derivative; callers must reauthorize before signing it. */
export async function prepareThumbnail(row: DriveRow): Promise<string | null> {
  if (!canThumbnail(row) || !row.objectKey) return null;
  const identity = row.objectKey;
  const existing = pending.get(identity);
  if (existing) return existing;
  const work = (async () => {
    if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await withStorageObjectLock(identity, async (confirmClaim) => {
        // A snapshot may have waited behind deletion: do not recreate a retired derivative.
        const retained = await withDriveTransaction("read", async (tx) => {
          const current = await tx.select({ id: driveItems.id }).from(driveItems).where(and(eq(driveItems.objectKey, identity), isNull(driveItems.deletionStartedAt))).limit(1);
          const version = await tx.select({ id: driveFileVersions.id }).from(driveFileVersions).where(eq(driveFileVersions.objectKey, identity)).limit(1);
          return current.length > 0 || version.length > 0;
        });
        if (!retained) return null;
        const key = contentThumbnailKey(row.id, identity);
        if (await thumbnailExists(key)) return key;
        const bytes = await readFileBytes(row, THUMBNAIL_SOURCE_BYTES);
        if (!bytes?.length) return null;
        const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        // Never feed active vector formats to Sharp, including SVG disguised as a raster upload.
        const jpeg = source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff;
        const png = source.length >= 8 && source.readUInt32BE(0) === 0x89504e47 && source.readUInt32BE(4) === 0x0d0a1a0a;
        const gif = source.toString("ascii", 0, 6) === "GIF87a" || source.toString("ascii", 0, 6) === "GIF89a";
        const webp = source.toString("ascii", 0, 4) === "RIFF" && source.toString("ascii", 8, 12) === "WEBP";
        const avif = source.toString("ascii", 4, 8) === "ftyp" && /^(?:avif|avis)$/.test(source.toString("ascii", 8, 12));
        if (!jpeg && !png && !gif && !webp && !avif) return null;
        let thumbnail: Buffer;
        try {
          thumbnail = await sharp(source, { limitInputPixels: 16_777_216, sequentialRead: true, pages: 1, failOn: "warning" })
            .rotate()
            .resize(320, 240, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 76, effort: 3 })
            .timeout({ seconds: 5 })
            .toBuffer();
        } catch {
          // Corrupt files, excessive dimensions, and unsupported decoders keep their ordinary file icon.
          return null;
        }
        await confirmClaim();
        await writeThumbnail(key, thumbnail);
        return key;
      });
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  })();
  pending.set(identity, work);
  try {
    return await work;
  } finally {
    pending.delete(identity);
  }
}
