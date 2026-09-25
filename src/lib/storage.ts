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
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { and, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { DriveFileVersionRow, DriveRow, UploadWorkRow } from "@/lib/drive-schema";
import type { DriveItem, UploadTicket } from "@/lib/drive-types";
import { withDriveTransaction } from "@/lib/drive-access";
import { getDb } from "@/lib/db";
import { DriveError } from "@/lib/drive-errors";
import { driveItems, driveUploadWork } from "@/lib/drive-schema";
import { MULTIPART_PART_BYTES, MULTIPART_THRESHOLD_BYTES } from "@/lib/drive-types";
import { withStorageObjectLock } from "@/lib/storage-work";
import type { DriveTransaction } from "@/lib/drive-access";
import { getPreviewKind } from "@/lib/file-preview";

/** Lazy reconciliation covers uploads reserved by the previous deployment after migration. */
export async function ensureUploadWork(tx: DriveTransaction, row: DriveRow) {
  if (row.kind !== "file" || row.state !== "pending" || !row.objectKey || !row.mimeType) return;
  await tx.insert(driveUploadWork).values({
    id: row.id, itemId: row.replacesId ?? row.id, objectKey: row.objectKey, multipartUploadId: row.multipartUploadId,
    multipart: row.multipartUploadId !== null, size: row.size, mimeType: row.mimeType, createdAt: row.createdAt,
    retainUntil: new Date(Date.now() + 25 * 60 * 60 * 1000),
  }).onConflictDoNothing();
  if (row.multipartUploadId) await tx.update(driveUploadWork).set({ multipartUploadId: row.multipartUploadId, multipart: true })
    .where(and(eq(driveUploadWork.id, row.id), eq(driveUploadWork.status, "pending")));
}

const DOWNLOAD_TTL_SECONDS = 60;
const UPLOAD_TTL_SECONDS = 60 * 60;
const MULTIPART_UPLOAD_TTL_SECONDS = 24 * 60 * 60;

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
  const linkActive = row.publicToken && (!row.publicExpiresAt || row.publicExpiresAt.getTime() > Date.now());
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parentId,
    owner: null,
    accessMode: row.accessMode,
    permission: "viewer",
    sharing: { public: null, members: null, membersInherited: false },
    size: row.size,
    mimeType: row.mimeType,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publicToken: linkActive ? row.publicToken : null,
    publicExpiresAt: linkActive ? row.publicExpiresAt?.toISOString() ?? null : null,
    trashedAt: row.trashedAt?.toISOString() ?? null,
    hasPassword: Boolean(row.passwordHash),
    isLocked: Boolean(row.passwordHash),
    isProtected: Boolean(row.passwordHash),
    searchExcluded: row.searchExcluded,
    tags: row.tags,
    description: row.description,
    folderColor: row.folderColor,
    folderEmoji: row.folderEmoji,
    isFavorite: false,
  };
}

export function createObjectKey(id: string) {
  return `files/${id}/${randomBytes(24).toString("hex")}`;
}

const OBJECT_KEY_PATTERN = /^files\/[0-9a-f-]{36}\/[0-9a-f]{48}$/;

export type UploadObject = Pick<DriveRow, "id" | "kind" | "objectKey" | "replacesId" | "multipartUploadId" | "mimeType" | "size" | "state" | "trashedAt">;

export function uploadWorkObject(work: UploadWorkRow): UploadObject {
  return { id: work.id, kind: "file", objectKey: work.objectKey, replacesId: work.itemId === work.id ? null : work.itemId,
    multipartUploadId: work.multipartUploadId, mimeType: work.mimeType, size: work.size, state: "pending", trashedAt: null };
}

function objectKey(row: UploadObject): string {
  // A pending replacement upload stores its bytes under the file it will become a version of.
  if (
    row.kind !== "file" || !row.objectKey ||
    !row.objectKey.startsWith(`files/${row.replacesId ?? row.id}/`) ||
    !OBJECT_KEY_PATTERN.test(row.objectKey)
  ) {
    throw new DriveError("This file cannot be accessed. Please contact the drive administrator.");
  }
  return row.objectKey;
}

function versionObjectKey(version: DriveFileVersionRow): string {
  if (!version.objectKey.startsWith(`files/${version.itemId}/`) || !OBJECT_KEY_PATTERN.test(version.objectKey)) {
    throw new DriveError("This version cannot be accessed. Please contact the drive administrator.");
  }
  return version.objectKey;
}

function stagedObjectKey(row: UploadObject) {
  return `uploads/${objectKey(row).slice("files/".length)}`;
}

export async function createMultipartUpload(row: UploadObject): Promise<string> {
  if (row.state !== "pending" || row.trashedAt || !row.mimeType) {
    throw new DriveError("This upload is no longer available.");
  }
  // If initiation reached R2 but its response never reached the journal, retire
  // those unsignable uploads before retrying under this object's exclusive claim.
  await abortUnrecordedMultipart(row);
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

export async function abortMultipartUpload(row: UploadObject) {
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

function partSize(row: UploadObject, partNumber: number) {
  return Math.min(MULTIPART_PART_BYTES, row.size - (partNumber - 1) * MULTIPART_PART_BYTES);
}

/** Signs the upload; for multipart, only the parts not in `completedParts` (a resumed upload skips what R2 already has). */
export async function signUpload(row: UploadObject, completedParts: number[] = []): Promise<UploadTicket> {
  if (row.state !== "pending" || row.trashedAt || !row.mimeType) {
    throw new DriveError("This upload is no longer available.");
  }
  const { client, bucket } = storage();
  if (row.multipartUploadId) {
    const key = objectKey(row);
    const uploadId = row.multipartUploadId;
    const done = new Set(completedParts);
    const partNumbers = Array.from({ length: Math.ceil(row.size / MULTIPART_PART_BYTES) }, (_, index) => index + 1);
    const parts = await Promise.all(partNumbers.filter((partNumber) => !done.has(partNumber)).map(async (partNumber) => {
      const url = await getSignedUrl(client, new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: partSize(row, partNumber),
      }), {
        expiresIn: MULTIPART_UPLOAD_TTL_SECONDS,
        signableHeaders: new Set(["content-length"]),
      });
      return { partNumber, url };
    }));
    return { mode: "multipart", id: row.id, partSize: MULTIPART_PART_BYTES, parts, completedParts: partNumbers.filter((partNumber) => done.has(partNumber)) };
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

/**
 * Parts of an unfinished multipart upload that R2 already stores with their expected length; the rest must be
 * (re)sent, and re-sending a part number replaces it. When the multipart upload is gone because R2 already
 * completed it, every part counts as sent so the client goes straight to completion, which verifies the object.
 */
export async function listUploadedParts(row: UploadObject): Promise<number[]> {
  if (!row.multipartUploadId) return [];
  const { client, bucket } = storage();
  const partCount = Math.ceil(row.size / MULTIPART_PART_BYTES);
  try {
    const upload = await client.send(new ListPartsCommand({ Bucket: bucket, Key: objectKey(row), UploadId: row.multipartUploadId, MaxParts: 1000 }));
    return (upload.Parts ?? []).flatMap((part) => part.PartNumber && part.PartNumber <= partCount && part.ETag && part.Size === partSize(row, part.PartNumber) ? [part.PartNumber] : []);
  } catch (error) {
    if (!(error instanceof Error && error.name === "NoSuchUpload")) throw error;
  }
  try {
    await verifyUpload(row, true);
  } catch (error) {
    if (error instanceof DriveError) throw new DriveError("This upload can no longer be resumed. Discard it and upload the file again.");
    throw error;
  }
  return Array.from({ length: partCount }, (_, index) => index + 1);
}

export async function verifyUpload(row: UploadObject, finalized = false): Promise<string> {
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

async function commitMultipartUpload(row: UploadObject, uploadId: string): Promise<string> {
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
      if (part.PartNumber !== index + 1 || !part.ETag || part.Size !== partSize(row, index + 1)) {
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

export async function commitUpload(row: UploadObject, publicationKey: string): Promise<string> {
  if (row.state !== "pending" || row.trashedAt) throw new DriveError("This upload is no longer available.");
  // Persisted mode preserves older large uploads that still use the single PUT path.
  if (row.multipartUploadId) {
    if (publicationKey !== row.objectKey) throw new DriveError("This upload has changed. Please try again.");
    return commitMultipartUpload(row, row.multipartUploadId);
  }
  // Legacy finalizers may still publish row.objectKey while this worker is in R2.
  // Their valid PUT ticket must never let us overwrite those published bytes.
  if (publicationKey === row.objectKey) throw new DriveError("This upload has no isolated publication identity.");
  const publication = { ...row, objectKey: publicationKey };
  const { client, bucket } = storage();
  const stagedEtag = await verifyUpload(row);
  await client.send(new CopyObjectCommand({
    Bucket: bucket,
    Key: objectKey(publication),
    CopySource: `${encodeURIComponent(bucket)}/${stagedObjectKey(row)}`,
    CopySourceIfMatch: stagedEtag,
    MetadataDirective: "COPY",
  }));
  return verifyUpload(publication, true);
}

/**
 * Duplicates a stored file for a copy: R2 copies the bytes server-side, nothing is downloaded.
 * The copy gets the target's own object key and upload-id metadata, so it verifies like any finished upload.
 */
export async function copyFileObject(source: DriveRow, target: DriveRow): Promise<string> {
  if (source.state !== "complete" || !source.etag) throw new DriveError("This file is not available to copy.");
  const { client, bucket } = storage();
  await client.send(new CopyObjectCommand({
    Bucket: bucket,
    Key: objectKey(target),
    CopySource: `${encodeURIComponent(bucket)}/${objectKey(source)}`,
    CopySourceIfMatch: source.etag,
    MetadataDirective: "REPLACE",
    ContentType: target.mimeType ?? undefined,
    Metadata: { "upload-id": target.id },
  }));
  return verifyUpload(target, true);
}

export async function removeStagedObject(row: UploadObject) {
  if (row.multipartUploadId) return;
  const { client, bucket } = storage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagedObjectKey(row) }));
}

export async function removeObject(row: UploadObject) {
  await abortMultipartUpload(row);
  const { client, bucket } = storage();
  // A pending row may already have a final object if a completion transaction failed.
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(row) }));
  await removeStagedObject(row);
  await removeThumbnail(row.id);
  await removeContentThumbnail(row.replacesId ?? row.id, objectKey(row));
}

/** Drops a file's cached preview thumbnail, e.g. after its contents change. */
export async function removeThumbnail(itemId: string) {
  const { client, bucket } = storage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: thumbnailKey(`thumbnails/${itemId}/preview-v1.webp`) }));
}

/** Derivatives belong to immutable content, not the mutable current-file pointer. */
export function contentThumbnailKey(itemId: string, key: string) {
  return thumbnailKey(`thumbnails/${itemId}/${key.split("/").at(-1)}-v2.webp`);
}

async function removeContentThumbnail(itemId: string, key: string) {
  const { client, bucket } = storage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: contentThumbnailKey(itemId, key) }));
}

export async function removeVersionObject(version: DriveFileVersionRow) {
  const { client, bucket } = storage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: versionObjectKey(version) }));
  await removeContentThumbnail(version.itemId, version.objectKey);
}

/** Queue retired versions before their relational reference disappears. */
export async function queueVersionCleanup(tx: DriveTransaction, version: DriveFileVersionRow) {
  await tx.insert(driveUploadWork).values({
    id: version.id, itemId: version.itemId, objectKey: version.objectKey, size: version.size, mimeType: version.mimeType,
    status: "cancelled", retainUntil: new Date(Date.now() + 25 * 60 * 60 * 1000),
  }).onConflictDoUpdate({ target: driveUploadWork.objectKey, set: { status: "cancelled" } });
}

export async function cleanupVersion(version: DriveFileVersionRow) {
  const [work] = await getDb().select({ id: driveUploadWork.id }).from(driveUploadWork).where(eq(driveUploadWork.objectKey, version.objectKey));
  if (work) await cleanupUpload(work.id);
}

/** Short-lived download link for an earlier version, named after the file. */
export async function signVersionDownload(version: DriveFileVersionRow, name: string): Promise<string> {
  const { client, bucket } = storage();
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: bucket,
    Key: versionObjectKey(version),
    ResponseContentDisposition: contentDisposition(name, false),
    ResponseContentType: "application/octet-stream",
    ResponseCacheControl: "private, no-store, max-age=0",
  }), { expiresIn: DOWNLOAD_TTL_SECONDS });
}

/** A crash between R2 initiation and persisting its response must not leak multipart uploads. */
async function abortUnrecordedMultipart(row: UploadObject) {
  if (row.size < MULTIPART_THRESHOLD_BYTES) return;
  const { client, bucket } = storage();
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const page = await client.send(new ListMultipartUploadsCommand({
      Bucket: bucket, Prefix: objectKey(row), KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker,
    }));
    for (const upload of page.Uploads ?? []) {
      if (upload.Key === objectKey(row) && upload.UploadId && upload.UploadId !== row.multipartUploadId) await abortMultipartUpload({ ...row, multipartUploadId: upload.UploadId });
    }
    if (!page.IsTruncated) break;
    keyMarker = page.NextKeyMarker;
    uploadIdMarker = page.NextUploadIdMarker;
  } while (keyMarker);
}

/** All durable references count, regardless of which deployment published the bytes. */
export async function referencedObjectKeys(tx: DriveTransaction, keys: string[]): Promise<Set<string>> {
  const list = sql.join(keys.map((key) => sql`${key}`), sql`, `);
  const rows = await tx.execute<{ key: string }>(sql`
    select object_key as key from drive_items where object_key in (${list}) and state = 'complete'
    union select object_key as key from drive_file_versions where object_key in (${list})
  `);
  return new Set(rows.map((row) => row.key));
}

/** Reconciles both legacy and isolated publication identities before retiring any bytes. */
export async function cleanupUpload(id: string) {
  const [snapshot] = await getDb().select().from(driveUploadWork).where(eq(driveUploadWork.id, id));
  if (!snapshot) return;
  const plan = await withStorageObjectLock(snapshot.objectKey, async () => {
    const plan = await withDriveTransaction("write", async (tx) => {
      const [work] = await tx.select().from(driveUploadWork).where(eq(driveUploadWork.id, id));
      if (!work) return null;
      const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id));
      if (work.status === "pending" && row?.state === "pending" && !row.trashedAt && !row.deletionStartedAt && row.createdAt.getTime() > Date.now() - 86_400_000) return null;
      const referenced = await referencedObjectKeys(tx, [work.objectKey, ...(work.publicationKey ? [work.publicationKey] : [])]);
      const status = referenced.size ? "published" as const : "cancelled" as const;
      await tx.update(driveUploadWork).set({ status }).where(eq(driveUploadWork.id, id));
      if (row?.state === "pending" && row.objectKey === work.objectKey) await tx.update(driveItems).set({ deletionStartedAt: new Date() }).where(eq(driveItems.id, id));
      return { work: { ...work, status }, referenced };
    });
    if (!plan) return null;
    const object = uploadWorkObject(plan.work);
    // A legacy single-PUT finalizer can win while new multipart initiation is in
    // flight. Abort that unsignable multipart even when its final key is referenced.
    await abortUnrecordedMultipart(object);
    if (!plan.referenced.has(plan.work.objectKey)) {
      await removeObject(object);
    } else {
      await abortMultipartUpload(object);
      if (plan.work.retainUntil.getTime() <= Date.now()) {
        // A replayed PUT can recreate staging, never remove its published final object.
        await removeStagedObject(object);
      }
    }
    return plan;
  });
  if (!plan) return;
  const { work } = plan;
  if (work.publicationKey && !plan.referenced.has(work.publicationKey)) {
    const publicationKey = work.publicationKey;
    // Never nest object claims: a busy thumbnail must not exhaust the claim pool.
    await withStorageObjectLock(publicationKey, async () => {
      const referenced = await withDriveTransaction("read", (tx) => referencedObjectKeys(tx, [publicationKey]));
      if (!referenced.has(publicationKey)) await removeObject({ ...uploadWorkObject(work), objectKey: publicationKey, multipartUploadId: null });
    });
  }
  await withDriveTransaction("write", async (tx) => {
    await tx.delete(driveItems).where(and(eq(driveItems.id, id), eq(driveItems.objectKey, work.objectKey), eq(driveItems.state, "pending"), isNotNull(driveItems.deletionStartedAt)));
    // Keep both identities through ticket expiry, and until every cleanup step succeeds.
    if (work.retainUntil.getTime() <= Date.now()) await tx.delete(driveUploadWork).where(and(eq(driveUploadWork.id, id), eq(driveUploadWork.status, work.status)));
  });
}

export async function pruneExpiredUploads() {
  const ids = await withDriveTransaction("write", async (tx) => {
    const expired = await tx.select().from(driveItems).where(and(
      eq(driveItems.state, "pending"),
      or(isNotNull(driveItems.trashedAt), isNotNull(driveItems.deletionStartedAt), lte(driveItems.createdAt, sql`now() - interval '24 hours'`)),
    )).limit(100);
    for (const row of expired) await ensureUploadWork(tx, row);
    if (expired.length) {
      const ids = expired.map((row) => row.id);
      await tx.update(driveUploadWork).set({ status: "cancelled" }).where(and(inArray(driveUploadWork.id, ids), eq(driveUploadWork.status, "pending")));
      await tx.update(driveItems).set({ deletionStartedAt: new Date() }).where(inArray(driveItems.id, ids));
    }
    return expired.map((row) => row.id);
  });
  const abandoned = await getDb().select({ id: driveUploadWork.id }).from(driveUploadWork).where(or(
    eq(driveUploadWork.status, "cancelled"),
    and(eq(driveUploadWork.status, "pending"), sql`not exists (select 1 from drive_items item where item.id = ${driveUploadWork.id} and item.state = 'pending')`),
  )).limit(100);
  for (const id of new Set([...ids, ...abandoned.map((row) => row.id)])) await cleanupUpload(id).catch(() => undefined);
  const published = await getDb().select().from(driveUploadWork).where(and(eq(driveUploadWork.status, "published"), lte(driveUploadWork.retainUntil, new Date()))).limit(100);
  for (const work of published) await cleanupUpload(work.id).catch(() => undefined);
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
  if (!/^thumbnails\/[0-9a-f-]{36}\/(?:preview-v1|[0-9a-f]{48}-v2)\.webp$/.test(key)) {
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
