import "server-only";

import { randomBytes } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { and, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import type { DriveRow } from "@/lib/drive-schema";
import type { DriveItem, UploadTicket } from "@/lib/drive-types";
import { canAccessPublic, withDriveTransaction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { driveItems } from "@/lib/drive-schema";
import { MULTIPART_PART_BYTES } from "@/lib/drive-types";
import { getPreviewKind } from "@/lib/file-preview";

const DOWNLOAD_TTL_SECONDS = 60;
const UPLOAD_TTL_SECONDS = 60 * 60;
const MULTIPART_UPLOAD_TTL_SECONDS = 24 * 60 * 60;
const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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
    publicToken: row.publicToken && (!row.publicExpiresAt || row.publicExpiresAt.getTime() > Date.now()) ? row.publicToken : null,
    trashedAt: row.trashedAt?.toISOString() ?? null,
    hasPassword: Boolean(row.passwordHash),
    isLocked: Boolean(row.passwordHash),
    isProtected: Boolean(row.passwordHash),
    tags: row.tags,
    description: row.description,
    folderColor: row.folderColor,
    isFavorite: false,
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

export async function createMultipartUpload(row: DriveRow): Promise<string> {
  if (row.state !== "pending" || row.trashedAt || !row.mimeType) {
    throw new DriveError("This upload is no longer available.");
  }
  const { client, bucket } = storage();
  const upload = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: objectKey(row),
    ContentType: row.mimeType,
    Metadata: { "upload-id": row.id },
  }));
  if (!upload.UploadId) throw new DriveError("File storage could not start the upload. Please try again.");
  return upload.UploadId;
}

export async function abortMultipartUpload(row: DriveRow) {
  if (!row.multipartUploadId) return;
  const { client, bucket } = storage();
  try {
    await client.send(new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: objectKey(row),
      UploadId: row.multipartUploadId,
    }));
  } catch (error) {
    if (!(error instanceof Error && error.name === "NoSuchUpload")) throw error;
  }
}

export async function signUpload(row: DriveRow): Promise<UploadTicket> {
  if (row.state !== "pending" || row.trashedAt || !row.mimeType) {
    throw new DriveError("This upload is no longer available.");
  }
  const { client, bucket } = storage();
  if (row.multipartUploadId) {
    const key = objectKey(row);
    const uploadId = row.multipartUploadId;
    const partCount = Math.ceil(row.size / MULTIPART_PART_BYTES);
    const parts = await Promise.all(Array.from({ length: partCount }, async (_, index) => {
      const partNumber = index + 1;
      const url = await getSignedUrl(client, new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: Math.min(MULTIPART_PART_BYTES, row.size - index * MULTIPART_PART_BYTES),
      }), {
        expiresIn: MULTIPART_UPLOAD_TTL_SECONDS,
        signableHeaders: new Set(["content-length"]),
      });
      return { partNumber, url };
    }));
    return { mode: "multipart", id: row.id, partSize: MULTIPART_PART_BYTES, parts };
  }
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
  return { mode: "single", id: row.id, url, headers };
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

async function commitMultipartUpload(row: DriveRow, uploadId: string): Promise<string> {
  const { client, bucket } = storage();
  const key = objectKey(row);
  try {
    // The 5 GiB limit allows at most 320 parts; a truncated list cannot be valid.
    const upload = await client.send(new ListPartsCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MaxParts: 1000,
    }));
    const partCount = Math.ceil(row.size / MULTIPART_PART_BYTES);
    if (upload.IsTruncated || upload.Parts?.length !== partCount) {
      throw new DriveError("The upload is missing parts or does not match the upload details. Finish uploading or cancel it and try again.");
    }
    const parts = upload.Parts.map((part, index) => {
      if (
        part.PartNumber !== index + 1 || !part.ETag ||
        part.Size !== Math.min(MULTIPART_PART_BYTES, row.size - index * MULTIPART_PART_BYTES)
      ) {
        throw new DriveError("The uploaded file does not match the upload details. Cancel it and upload the file again.");
      }
      return { PartNumber: part.PartNumber, ETag: part.ETag };
    });
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));
  } catch (error) {
    // R2 completion may have succeeded before a response or database commit failed.
    // Only an exact final-object match can recover an upload that no longer exists.
    if (!(error instanceof Error && error.name === "NoSuchUpload")) throw error;
  }
  return verifyUpload(row, true);
}

export async function commitUpload(row: DriveRow): Promise<string> {
  if (row.state !== "pending" || row.trashedAt) throw new DriveError("This upload is no longer available.");
  // Persisted mode preserves older large uploads that still use the single PUT path.
  if (row.multipartUploadId) return commitMultipartUpload(row, row.multipartUploadId);
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
  if (row.multipartUploadId) return;
  const { client, bucket } = storage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagedObjectKey(row) }));
}

export async function removeObject(row: DriveRow) {
  await abortMultipartUpload(row);
  const { client, bucket } = storage();
  // A pending row may already have a final object if a completion transaction failed.
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(row) }));
  await removeStagedObject(row);
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `thumbnails/${row.id}/preview-v1.webp` }));
}

export async function pruneExpiredUploads() {
  await withDriveTransaction("write", async (tx) => {
    const expired = await tx.select().from(driveItems).where(and(
      eq(driveItems.state, "pending"),
      or(isNotNull(driveItems.trashedAt), lte(driveItems.createdAt, sql`now() - interval '24 hours'`)),
    )).limit(100).for("update");
    for (const row of expired) {
      try {
        await removeObject(row);
      } catch {
        // Keep the pending tombstone so a later cleanup can safely retry.
        continue;
      }
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

export async function signDownload(row: DriveRow, preview = false, expiresIn = DOWNLOAD_TTL_SECONDS): Promise<string | null> {
  if (row.state !== "complete" || row.trashedAt || row.kind !== "file" || !row.etag || !row.mimeType) {
    throw new DriveError("This file is not available for download.");
  }
  const previewKind = preview ? getPreviewKind(row) : null;
  if (preview && !previewKind) return null;
  if (expiresIn < 1) return null;
  const { client, bucket } = storage();
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: bucket,
    Key: objectKey(row),
    ResponseContentDisposition: contentDisposition(row.name, preview),
    ResponseContentType: previewKind === "text" ? "text/plain; charset=utf-8" : preview ? row.mimeType : "application/octet-stream",
    ResponseCacheControl: "private, no-store, max-age=0",
  }), { expiresIn: Math.min(DOWNLOAD_TTL_SECONDS, Math.floor(expiresIn)) });
}

export async function readFileBytes(row: DriveRow, maxBytes: number): Promise<Uint8Array | null> {
  if (row.state !== "complete" || row.trashedAt || row.kind !== "file" || row.size > maxBytes || row.size === 0) return null;
  const { client, bucket } = storage();
  const abort = new AbortController();
  const response = await client.send(new GetObjectCommand({
    Bucket: bucket, Key: objectKey(row), Range: `bytes=0-${maxBytes}`,
  }), { abortSignal: abort.signal });
  if (!response.Body) return null;
  const reader = response.Body.transformToWebStream().getReader();
  const bytes = new Uint8Array(row.size);
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > bytes.byteLength) {
        abort.abort();
        return null;
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    return offset === row.size ? bytes : null;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function thumbnailKey(key: string): string {
  if (!/^thumbnails\/[0-9a-f-]{36}\/preview-v1\.webp$/.test(key)) {
    throw new DriveError("This thumbnail is not available.");
  }
  return key;
}

export async function thumbnailExists(key: string): Promise<boolean> {
  const { client, bucket } = storage();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: thumbnailKey(key) }));
    return true;
  } catch (error) {
    if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) return false;
    throw error;
  }
}

export async function writeThumbnail(key: string, bytes: Uint8Array): Promise<void> {
  const { client, bucket } = storage();
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: thumbnailKey(key), Body: bytes, ContentType: "image/webp",
    CacheControl: "private, no-store, max-age=0",
  }));
}

export async function signThumbnail(key: string): Promise<string> {
  const { client, bucket } = storage();
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: bucket, Key: thumbnailKey(key), ResponseContentType: "image/webp",
    ResponseContentDisposition: "inline", ResponseCacheControl: "private, no-store, max-age=0",
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
  sharedByEmail: string | null;
} | null> {
  if (!PUBLIC_TOKEN_PATTERN.test(token)) return null;
  return withDriveTransaction("read", async (tx) => {
    const [row] = await tx.select().from(driveItems).where(and(
      eq(driveItems.publicToken, token),
      eq(driveItems.kind, "file"),
      eq(driveItems.state, "complete"),
      sql`(${driveItems.publicExpiresAt} is null or ${driveItems.publicExpiresAt} > clock_timestamp())`,
    )).limit(1).for("share");
    if (!row || !(await canAccessPublic(tx, row))) return null;
    const expiresIn = row.publicExpiresAt ? Math.min(DOWNLOAD_TTL_SECONDS, Math.floor((row.publicExpiresAt.getTime() - Date.now()) / 1000)) : DOWNLOAD_TTL_SECONDS;
    const [downloadUrl, previewUrl] = await Promise.all([signDownload(row, false, expiresIn), signDownload(row, true, expiresIn)]);
    if (!downloadUrl) return null;
    // Never expose the family's folder structure through an unauthenticated share page.
    return { item: { ...toDriveItem(row), parentId: null }, downloadUrl, previewUrl, sharedByEmail: row.sharedByEmail };
  });
}
