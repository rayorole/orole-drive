import "server-only";

import type { DriveContext, DriveTransaction } from "@/lib/drive-access";
import type { DriveRow } from "@/lib/drive-schema";
import type { DriveItem, UploadResolution, UploadTicket } from "@/lib/drive-types";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { recordEvents } from "@/lib/activity";
import { numberedName } from "@/lib/copy-name";
import { assertCapability, assertItemAccess, assertItemsAccess, getItemAccess, withDriveTransaction } from "@/lib/drive-access";
import { DriveError, NameConflictError } from "@/lib/drive-errors";
import { driveActivity, driveItems } from "@/lib/drive-schema";
import { folderPath, MAX_FOLDER_DEPTH } from "@/lib/drive-tree";
import { MULTIPART_THRESHOLD_BYTES } from "@/lib/drive-types";
import { prioritizeScans } from "@/lib/file-risk";
import { afterContentChange, replaceFileContent, type ContentReplacement } from "@/lib/file-versions";
import { destinationSiblings, findConflicts, type DestinationSibling } from "@/lib/name-conflicts";
import { assertQuota } from "@/lib/quota";
import { abortMultipartUpload, commitUpload, createMultipartUpload, createObjectKey, removeObject, removeStagedObject, signUpload, toDriveItem } from "@/lib/storage";
import { cancelTrashedUploads, trashRows } from "@/lib/trash";

export async function itemData(tx: DriveTransaction, ctx: DriveContext, row: DriveRow): Promise<DriveItem> {
  return { ...toDriveItem(row), ...await getItemAccess(tx, ctx, row) };
}

/** The destination's folder path, once this session may add to it. */
export async function uploadDestination(tx: DriveTransaction, ctx: DriveContext, parentId: string | null): Promise<DriveRow[]> {
  const path = await folderPath(tx, parentId);
  if (path.length) await assertItemAccess(tx, ctx, path[path.length - 1]);
  else await assertItemsAccess(tx, ctx, []);
  return path;
}

type Incoming = { key: string; name: string; kind: "file" | "folder" };
type Placement = { name: string; replacesId: string | null; trashedUploadIds: string[] };

/**
 * Settles an incoming item's name in the destination. A clash with a complete item needs a resolution, otherwise
 * NameConflictError asks the client. Keep both takes a numbered name that also avoids unfinished uploads there.
 * Replace makes a file upload over a file its new version; any other clash sends the existing item to Trash
 * (pass `trashedUploadIds` to `cancelTrashedUploads` after commit).
 */
async function placeIncoming(tx: DriveTransaction, ctx: DriveContext, incoming: Incoming, parentId: string | null, siblings: Map<string, DestinationSibling>, resolution: UploadResolution | undefined): Promise<Placement> {
  const [conflict] = findConflicts([{ id: incoming.key, name: incoming.name, kind: incoming.kind }], siblings);
  if (!conflict) return { name: incoming.name, replacesId: null, trashedUploadIds: [] };
  if (!resolution) throw new NameConflictError([conflict]);
  if (resolution === "keep-both") {
    const uploading = await tx.select({ name: driveItems.name }).from(driveItems).where(and(
      parentId ? eq(driveItems.parentId, parentId) : isNull(driveItems.parentId),
      eq(driveItems.state, "pending"),
      isNull(driveItems.trashedAt),
    ));
    const taken = new Set([...siblings.keys(), ...uploading.map((row) => row.name.toLowerCase())]);
    return { name: numberedName(incoming.name, incoming.kind, taken), replacesId: null, trashedUploadIds: [] };
  }
  if (incoming.kind === "file" && conflict.existingKind === "file") {
    // The file keeps its own name; only its content changes.
    return { name: siblings.get(incoming.name.toLowerCase())?.name ?? incoming.name, replacesId: conflict.existingId, trashedUploadIds: [] };
  }
  assertCapability("trash");
  return { name: incoming.name, replacesId: null, trashedUploadIds: await trashRows(tx, ctx, [conflict.existingId], { reason: "replaced" }) };
}

export type UploadRequest = { key: string; name: string; size: number; mimeType: string; parentId: string | null; resolution?: UploadResolution };

/** Reserves a pending upload (access, name clash and quota checks) and signs where its bytes go. */
export async function startUpload(ctx: DriveContext, request: UploadRequest): Promise<UploadTicket> {
  let multipartRow: DriveRow | undefined;
  const { ticket, trashedUploadIds } = await withDriveTransaction("write", async (tx) => {
    await uploadDestination(tx, ctx, request.parentId);
    const siblings = await destinationSiblings(tx, request.parentId);
    const placement = await placeIncoming(tx, ctx, { key: request.key, name: request.name, kind: "file" }, request.parentId, siblings, request.resolution);
    await assertQuota(tx, ctx, request.size);
    const id = randomUUID();
    const [row] = await tx.insert(driveItems).values({
      id, name: placement.name, size: request.size, mimeType: request.mimeType, parentId: request.parentId, kind: "file", state: "pending",
      // A replacement stores its bytes under the file it becomes a version of, so completion only swaps keys.
      objectKey: createObjectKey(placement.replacesId ?? id), replacesId: placement.replacesId, createdBy: ctx.userId,
    }).returning();
    if (request.size < MULTIPART_THRESHOLD_BYTES) return { ticket: await signUpload(row), trashedUploadIds: placement.trashedUploadIds };
    const multipartUploadId = await createMultipartUpload(row);
    multipartRow = { ...row, multipartUploadId };
    await tx.update(driveItems).set({ multipartUploadId }).where(eq(driveItems.id, id));
    return { ticket: await signUpload(multipartRow), trashedUploadIds: placement.trashedUploadIds };
  }).catch(async (error: unknown) => {
    if (multipartRow) await abortMultipartUpload(multipartRow).catch(() => undefined);
    throw error;
  });
  await cancelTrashedUploads(trashedUploadIds);
  return ticket;
}

type Completion = { staged: DriveRow; item: DriveItem; replaced: ContentReplacement | null };

async function completeReplacement(tx: DriveTransaction, ctx: DriveContext, row: DriveRow, fileId: string): Promise<Completion | null> {
  const [file] = await tx.select().from(driveItems).where(eq(driveItems.id, fileId)).for("update");
  if (!file || file.state !== "complete" || file.trashedAt || file.deletionStartedAt) {
    // Nothing left to become a version of: drop the upload so it stops holding storage.
    await removeObject(row);
    await tx.delete(driveItems).where(eq(driveItems.id, row.id));
    return null;
  }
  await assertItemAccess(tx, ctx, file);
  const etag = await commitUpload(row);
  // Frees the object key the file takes over.
  await tx.delete(driveItems).where(eq(driveItems.id, row.id));
  const replaced = await replaceFileContent(tx, file, { objectKey: row.objectKey!, size: row.size, mimeType: row.mimeType!, etag, createdBy: row.createdBy });
  await tx.insert(driveActivity).values({ userId: ctx.userId, itemId: file.id, accessedAt: new Date() })
    .onConflictDoUpdate({ target: [driveActivity.userId, driveActivity.itemId], set: { accessedAt: new Date() } });
  await recordEvents(tx, ctx, [{ action: "new_version", item: { id: file.id, name: file.name, kind: "file", parentId: file.parentId }, details: { versionId: replaced.version.id, size: row.size } }]);
  return { staged: row, item: await itemData(tx, ctx, replaced.file), replaced };
}

/** Publishes an upload's bytes: a new file becomes available, a replacement becomes its file's current version. */
export async function finishUpload(ctx: DriveContext, id: string): Promise<DriveItem> {
  const result = await withDriveTransaction("write", async (tx): Promise<Completion | null> => {
    const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id)).for("update");
    if (!row || row.kind !== "file") throw new DriveError("This upload is no longer available.");
    await assertItemAccess(tx, ctx, row);
    if (row.state === "complete") return { staged: row, item: await itemData(tx, ctx, row), replaced: null };
    if (row.replacesId) return completeReplacement(tx, ctx, row, row.replacesId);
    const etag = await commitUpload(row);
    const [completed] = await tx.update(driveItems).set({ state: "complete", etag, updatedAt: new Date() }).where(eq(driveItems.id, id)).returning();
    await tx.insert(driveActivity).values({ userId: ctx.userId, itemId: id, accessedAt: new Date() })
      .onConflictDoUpdate({ target: [driveActivity.userId, driveActivity.itemId], set: { accessedAt: new Date() } });
    await recordEvents(tx, ctx, [{ action: "upload", item: { id, name: completed.name, kind: "file", parentId: completed.parentId }, details: { size: completed.size } }]);
    return { staged: row, item: await itemData(tx, ctx, completed), replaced: null };
  });
  if (!result) throw new DriveError("The file this upload was replacing is in Trash or was deleted, so the upload was cancelled. Upload it again to add it as a new file.");
  // Never remove staging before the database commit: a rolled-back single PUT
  // completion must still be retryable with the original verified source.
  await removeStagedObject(result.staged).catch(() => undefined);
  if (result.replaced) await afterContentChange(result.item, result.replaced.pruned);
  // Score the new file and, if it looks risky, look it up on VirusTotal ahead of everything else.
  else if (!result.item.isProtected) after(() => prioritizeScans([result.item.id]));
  return result.item;
}

export async function cancelPendingUpload(ctx: DriveContext, id: string): Promise<void> {
  await withDriveTransaction("write", async (tx) => {
    const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id)).for("update");
    if (!row) return;
    if (row.kind !== "file" || row.state !== "pending") throw new DriveError("This upload has already completed. Move the file to Trash instead.");
    await assertItemAccess(tx, ctx, row, { allowTrashed: true });
    await removeObject(row);
    await tx.delete(driveItems).where(eq(driveItems.id, id));
  });
}

/**
 * The folder called `name` for a folder upload: an existing folder with that name (any case) is reused, so the upload
 * merges into it; otherwise a new folder is created, settling a clash with a file like any other upload.
 */
export async function ensureUploadFolder(ctx: DriveContext, request: { key: string; name: string; parentId: string | null; resolution?: UploadResolution }): Promise<{ folder: DriveItem; created: boolean }> {
  const { result, trashedUploadIds } = await withDriveTransaction("write", async (tx) => {
    const path = await uploadDestination(tx, ctx, request.parentId);
    const siblings = await destinationSiblings(tx, request.parentId);
    const existing = siblings.get(request.name.toLowerCase());
    if (existing?.kind === "folder") {
      const [folder] = await tx.select().from(driveItems).where(eq(driveItems.id, existing.id));
      await assertItemAccess(tx, ctx, folder);
      return { result: { folder: await itemData(tx, ctx, folder), created: false }, trashedUploadIds: [] };
    }
    if (path.length >= MAX_FOLDER_DEPTH) throw new DriveError("Folders can be nested up to 64 levels deep.");
    const placement = await placeIncoming(tx, ctx, { key: request.key, name: request.name, kind: "folder" }, request.parentId, siblings, request.resolution);
    const [folder] = await tx.insert(driveItems).values({
      id: randomUUID(), name: placement.name, parentId: request.parentId, kind: "folder", state: "complete", size: 0, createdBy: ctx.userId,
    }).returning();
    await recordEvents(tx, ctx, [{ action: "create_folder", item: { id: folder.id, name: folder.name, kind: "folder", parentId: folder.parentId } }]);
    return { result: { folder: await itemData(tx, ctx, folder), created: true }, trashedUploadIds: placement.trashedUploadIds };
  });
  await cancelTrashedUploads(trashedUploadIds);
  return result;
}
