import "server-only";

import { randomBytes } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { and, eq, lte, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { driveItems, type DriveRow } from "@/lib/drive-schema";
import type { DriveItem } from "@/lib/drive-types";

const DOWNLOAD_TTL_SECONDS = 60;
const UPLOAD_TTL_SECONDS = 60 * 60;
const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PREVIEW_TYPES: Record<string, true> = {
  "image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true, "image/avif": true, "image/bmp": true,
  "audio/mpeg": true, "audio/mp4": true, "audio/ogg": true, "audio/wav": true, "audio/webm": true, "audio/flac": true, "audio/aac": true,
  "video/mp4": true, "video/webm": true, "video/ogg": true, "video/quicktime": true,
  "application/pdf": true,
};

export class DriveError extends Error {}

let storageClient: S3Client | undefined;

function storage() {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new DriveError("File storage is not configured yet. Please contact the drive administrator.");
  }
  const origin = new URL(endpoint);
  if (
    origin.protocol !== "https:" ||
    !origin.hostname.endsWith(".r2.cloudflarestorage.com") ||
    origin.username || origin.password || origin.search || origin.hash ||
    (origin.pathname !== "/" && origin.pathname !== "")
  ) {
    throw new DriveError("File storage is not configured correctly. Please contact the drive administrator.");
  }
  storageClient ??= new S3Client({
    region: "auto",
    endpoint: origin.origin,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return { client: storageClient, bucket };
}

export function toDriveItem(row: DriveRow): DriveItem {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parentId,
    size: row.size,
    mimeType: row.mimeType,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publicToken: row.publicToken,
  };
}

export function createObjectKey(id: string) {
  return `files/${id}/${randomBytes(24).toString("hex")}`;
}

function objectKey(row: DriveRow): string {
  if (
    row.kind !== "file" || !row.objectKey ||
    !row.objectKey.startsWith(`files/${row.id}/`) ||
    !/^files\/[0-9a-f-]{36}\/[0-9a-f]{48}$/.test(row.objectKey)
  ) {
    throw new DriveError("This file cannot be accessed. Please contact the drive administrator.");
  }
  return row.objectKey;
}

function stagedObjectKey(row: DriveRow) {
  return `uploads/${objectKey(row).slice("files/".length)}`;
}

export async function signUpload(row: DriveRow) {
  if (row.state !== "pending" || !row.mimeType) {
    throw new DriveError("This upload is no longer available.");
  }
  const { client, bucket } = storage();
  const headers = {
    "Content-Type": row.mimeType,
    "If-None-Match": "*",
    "x-amz-meta-upload-id": row.id,
  };
  const url = await getSignedUrl(client, new PutObjectCommand({
    Bucket: bucket,
    Key: stagedObjectKey(row),
    ContentLength: row.size,
    ContentType: row.mimeType,
    IfNoneMatch: "*",
    Metadata: { "upload-id": row.id },
  }), {
    expiresIn: UPLOAD_TTL_SECONDS,
    // These headers must not be omitted or changed by a bearer of the URL.
    signableHeaders: new Set(["content-type", "content-length", "if-none-match", "x-amz-meta-upload-id"]),
    unhoistableHeaders: new Set(["x-amz-meta-upload-id"]),
  });
  return { id: row.id, url, headers };
}

export async function verifyUpload(row: DriveRow, finalized = false): Promise<string> {
  const { client, bucket } = storage();
  let head;
  try {
    head = await client.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: finalized ? objectKey(row) : stagedObjectKey(row),
    }));
  } catch (error) {
    if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) {
      throw new DriveError("The upload is not in storage yet. Finish uploading before trying again.");
    }
    throw error;
  }
  if (
    head.ContentLength !== row.size || head.ContentType !== row.mimeType ||
    head.Metadata?.["upload-id"] !== row.id || !head.ETag
  ) {
    throw new DriveError("The uploaded file does not match the upload details. Cancel it and upload the file again.");
  }
  return head.ETag;
}

export async function commitUpload(row: DriveRow): Promise<string> {
  const { client, bucket } = storage();
  const stagedEtag = await verifyUpload(row);
  await client.send(new CopyObjectCommand({
    Bucket: bucket,
    Key: objectKey(row),
    CopySource: `${encodeURIComponent(bucket)}/${stagedObjectKey(row)}`,
    CopySourceIfMatch: stagedEtag,
    MetadataDirective: "COPY",
  }));
  return verifyUpload(row, true);
}

export async function removeStagedObject(row: DriveRow) {
  const { client, bucket } = storage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagedObjectKey(row) }));
}

export async function removeObject(row: DriveRow) {
  const { client, bucket } = storage();
  // A pending row may already have a final copy if a prior completion transaction failed.
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(row) }));
  await removeStagedObject(row);
}

export async function pruneExpiredUploads() {
  await getDb().transaction(async (tx) => {
    const expired = await tx.select().from(driveItems).where(and(
      eq(driveItems.state, "pending"),
      lte(driveItems.createdAt, sql`now() - interval '24 hours'`),
    )).for("update", { skipLocked: true });
    for (const row of expired) {
      await removeObject(row);
      await tx.delete(driveItems).where(eq(driveItems.id, row.id));
    }
  });
}

function contentDisposition(name: string, inline: boolean) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function signDownload(row: DriveRow, preview = false): Promise<string | null> {
  if (row.state !== "complete" || row.kind !== "file" || !row.etag || !row.mimeType) {
    throw new DriveError("This file is not available for download.");
  }
  if (preview && PREVIEW_TYPES[row.mimeType] !== true) return null;
  const { client, bucket } = storage();
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: bucket,
    Key: objectKey(row),
    ResponseContentDisposition: contentDisposition(row.name, preview),
    ResponseContentType: preview ? row.mimeType : "application/octet-stream",
    ResponseCacheControl: "private, no-store, max-age=0",
  }), { expiresIn: DOWNLOAD_TTL_SECONDS });
}

export function createPublicToken() {
  return randomBytes(32).toString("base64url");
}

export function publicShareUrl(token: string) {
  const base = process.env.BETTER_AUTH_URL;
  if (!base) throw new DriveError("The drive address is not configured. Please contact the drive administrator.");
  const url = new URL(base);
  if (
    url.username || url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new DriveError("The drive address is not configured correctly. Please contact the drive administrator.");
  }
  return new URL(`/s/${token}`, url.origin).toString();
}

export async function getPublicFile(token: string): Promise<{
  item: DriveItem;
  downloadUrl: string;
  previewUrl: string | null;
} | null> {
  if (!PUBLIC_TOKEN_PATTERN.test(token)) return null;
  return getDb().transaction(async (tx) => {
    // Revocation/deletion waits for issued links; requests after it commits see no share.
    const [row] = await tx.select().from(driveItems).where(and(
      eq(driveItems.publicToken, token),
      eq(driveItems.kind, "file"),
      eq(driveItems.state, "complete"),
    )).limit(1).for("share");
    if (!row) return null;
    const [downloadUrl, previewUrl] = await Promise.all([signDownload(row), signDownload(row, true)]);
    if (!downloadUrl) return null;
    // Never expose the family's folder structure through an unauthenticated share page.
    return { item: { ...toDriveItem(row), parentId: null }, downloadUrl, previewUrl };
  });
}
