import "server-only";

import type { DriveContext, DriveTransaction } from "@/lib/drive-access";
import type { DriveRow } from "@/lib/drive-schema";
import type { DriveItem, DriveNameConflict, UploadResolution, UploadTicket } from "@/lib/drive-types";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { recordEvents } from "@/lib/activity";
import { numberedName } from "@/lib/copy-name";
import { assertCapability, assertItemAccess, assertItemsAccess, getItemAccess, visibleItemsCondition, withDriveTransaction } from "@/lib/drive-access";
import { DriveError, NameConflictError } from "@/lib/drive-errors";
import { driveActivity, driveItems, driveUploadWork } from "@/lib/drive-schema";
import { folderPath, MAX_FOLDER_DEPTH } from "@/lib/drive-tree";
import { MULTIPART_THRESHOLD_BYTES } from "@/lib/drive-types";
import { prioritizeScans } from "@/lib/file-risk";
import { afterContentChange, replaceFileContent, type ContentReplacement } from "@/lib/file-versions";
import { destinationSiblings, findConflicts, type DestinationSibling } from "@/lib/name-conflicts";
import { assertQuota } from "@/lib/quota";
import { cleanupUpload, commitUpload, createMultipartUpload, createObjectKey, ensureUploadWork, listUploadedParts, referencedObjectKeys, removeStagedObject, signUpload, toDriveItem } from "@/lib/storage";
import { getDb } from "@/lib/db";
import { assertMutationGuard, assertMutationGuardIdentity, completeMutationGuard, currentMutationGuardId } from "@/lib/drive-mutation-guard";
import { enqueueSearch } from "@/lib/search-index";
import { withStorageObjectLock } from "@/lib/storage-work";
import { cancelTrashedUploads, trashRows } from "@/lib/trash";

export async function itemData(tx: DriveTransaction, ctx: DriveContext, row: DriveRow): Promise<DriveItem> {
  return { ...toDriveItem(row), ...await getItemAccess(tx, ctx, row) };
}

/** The destination's folder path, once this session may add to it. */
export async function uploadDestination(tx: DriveTransaction, ctx: DriveContext, parentId: string | null, options: { allowTrashed?: boolean } = {}): Promise<DriveRow[]> {
  const path = await folderPath(tx, parentId);
  if (path.length) await assertItemAccess(tx, ctx, path[path.length - 1], { ...options, permission: "write" });
  else await assertItemsAccess(tx, ctx, [], { permission: "write" });
  return path;
}

/** Owning a pending upload does not preserve permission to write into a destination after its sharing changes. */
export async function assertUploadAccess(tx: DriveTransaction, ctx: DriveContext, row: DriveRow, options: { allowTrashed?: boolean } = {}): Promise<void> {
  await assertItemAccess(tx, ctx, row, { ...options, permission: "write" });
  await uploadDestination(tx, ctx, row.parentId, options);
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
      parentId ? eq(driveItems.parentId, parentId) : and(isNull(driveItems.parentId), eq(driveItems.ownerId, ctx.userId)),
      visibleItemsCondition(ctx, { permission: "write", includePending: true }),
      eq(driveItems.state, "pending"),
      isNull(driveItems.trashedAt),
    ));
    const taken = new Set([...siblings.keys(), ...uploading.map((row) => row.name.toLowerCase())]);
    return { name: numberedName(incoming.name, incoming.kind, taken), replacesId: null, trashedUploadIds: [] };
  }
  if (incoming.kind === "file" && conflict.existingKind === "file") {
    const [file] = await tx.select().from(driveItems).where(eq(driveItems.id, conflict.existingId));
    if (!file) throw new DriveError("This file is no longer available.");
    await assertUploadAccess(tx, ctx, file);
    // The file keeps its own name; only its content changes.
    return { name: siblings.get(incoming.name.toLowerCase())?.name ?? incoming.name, replacesId: conflict.existingId, trashedUploadIds: [] };
  }
  assertCapability("trash");
  return { name: incoming.name, replacesId: null, trashedUploadIds: await trashRows(tx, ctx, [conflict.existingId], { reason: "replaced" }) };
}

export type UploadRequest = { key: string; name: string; size: number; mimeType: string; parentId: string | null; resolution?: UploadResolution };

/** Authorizes the live pending row and its replacement target, never a stale storage snapshot. */
async function pendingUpload(tx: DriveTransaction, ctx: DriveContext, id: string, ownOnly = false): Promise<DriveRow> {
  const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id));
  if (row) await ensureUploadWork(tx, row);
  const [work] = await tx.select().from(driveUploadWork).where(eq(driveUploadWork.id, id));
  assertMutationGuardIdentity(work?.mutationGuardId ?? null);
  if (!row || row.kind !== "file" || row.state !== "pending" || row.trashedAt || row.deletionStartedAt ||
      !work || work.status !== "pending" || work.objectKey !== row.objectKey ||
      (ownOnly && row.createdBy !== ctx.userId) || row.createdAt.getTime() <= Date.now() - 86_400_000) {
    throw new DriveError("This upload is no longer available. Upload the file again.");
  }
  await assertUploadAccess(tx, ctx, row);
  if (row.replacesId) {
    const [file] = await tx.select().from(driveItems).where(eq(driveItems.id, row.replacesId));
    if (!file || file.state !== "complete" || file.trashedAt || file.deletionStartedAt) throw new DriveError("The file this upload was replacing is no longer available.");
    await assertUploadAccess(tx, ctx, file);
  }
  return row;
}

/** Storage discovery/initiation happens under an object claim, not the hierarchy lock. */
export async function uploadTicket(ctx: DriveContext, id: string, resume = false): Promise<UploadTicket> {
  const snapshot = await withDriveTransaction("read", (tx) => pendingUpload(tx, ctx, id, resume));
  return withStorageObjectLock(snapshot.objectKey!, async (confirmClaim) => {
    let row = await withDriveTransaction("read", (tx) => pendingUpload(tx, ctx, id, resume));
    const [work] = await getDb().select().from(driveUploadWork).where(eq(driveUploadWork.id, id));
    let multipartUploadId = work.multipartUploadId;
    // Multipart intent is durable before initiation, including response-loss recovery.
    if (!multipartUploadId && work.multipart) {
      multipartUploadId = await createMultipartUpload(row);
      await confirmClaim();
      await getDb().update(driveUploadWork).set({ multipartUploadId }).where(eq(driveUploadWork.id, id));
    }
    row = { ...row, multipartUploadId };
    const completedParts = resume ? await listUploadedParts(row) : [];
    await confirmClaim();
    return withDriveTransaction("write", async (tx) => {
      const current = await pendingUpload(tx, ctx, id, resume);
      if (current.objectKey !== row.objectKey) throw new DriveError("This upload is no longer available.");
      await tx.update(driveItems).set({ multipartUploadId }).where(eq(driveItems.id, id));
      await tx.update(driveUploadWork).set({ retainUntil: sql`now() + interval '25 hours'` }).where(eq(driveUploadWork.id, id));
      return signUpload({ ...current, multipartUploadId }, completedParts);
    });
  });
}

/** Reservation itself returns NameConflictError; there is no separate file-name preflight. */
export async function startUpload(ctx: DriveContext, request: UploadRequest): Promise<UploadTicket> {
  const { id, ticket, trashedUploadIds } = await withDriveTransaction("write", async (tx) => {
    await uploadDestination(tx, ctx, request.parentId);
    await assertMutationGuard(tx, ctx, { operation: "upload", name: request.name, parentId: request.parentId, size: request.size, mimeType: request.mimeType });
    const siblings = await destinationSiblings(tx, ctx, request.parentId);
    const placement = await placeIncoming(tx, ctx, { key: request.key, name: request.name, kind: "file" }, request.parentId, siblings, request.resolution);
    await assertQuota(tx, ctx, request.size);
    const id = randomUUID();
    const now = new Date();
    const key = createObjectKey(placement.replacesId ?? id);
    const [row] = await tx.insert(driveItems).values({
      id, name: placement.name, size: request.size, mimeType: request.mimeType, parentId: request.parentId, kind: "file", state: "pending",
      objectKey: key, replacesId: placement.replacesId, createdBy: ctx.userId, createdAt: now,
      ownerId: ctx.userId, accessMode: request.parentId ? "inherit" : "private",
    }).returning();
    await tx.insert(driveUploadWork).values({
      id, itemId: placement.replacesId ?? id, objectKey: key, size: request.size, mimeType: request.mimeType,
      createdAt: now, retainUntil: new Date(now.getTime() + 25 * 60 * 60 * 1000),
      multipart: request.size >= MULTIPART_THRESHOLD_BYTES,
      mutationGuardId: currentMutationGuardId(),
    });
    // Presigning uses configured local credentials, not R2 I/O. Ordinary files
    // retain the one-transaction reservation fast path.
    const ticket = request.size < MULTIPART_THRESHOLD_BYTES ? await signUpload(row) : null;
    return { id, ticket, trashedUploadIds: placement.trashedUploadIds };
  });
  await cancelTrashedUploads(trashedUploadIds);
  if (ticket) return ticket;
  try {
    return await uploadTicket(ctx, id);
  } catch (error) {
    // No ticket reached the caller: retire the reservation durably, including a
    // multipart initiation whose response was lost. A retry starts cleanly.
    await withDriveTransaction("write", async (tx) => {
      await tx.update(driveUploadWork).set({ status: "cancelled" }).where(and(eq(driveUploadWork.id, id), eq(driveUploadWork.status, "pending")));
      await tx.update(driveItems).set({ deletionStartedAt: new Date() }).where(and(eq(driveItems.id, id), eq(driveItems.state, "pending")));
    });
    await cleanupUpload(id).catch(() => undefined);
    throw error;
  }
}

type Completion = { staged: DriveRow | null; item: DriveItem; replaced: ContentReplacement | null };

/** Claim -> authorized snapshot -> R2 -> fresh authorization + atomic publication. */
export async function finishUpload(ctx: DriveContext, id: string): Promise<DriveItem> {
  const identity = await withDriveTransaction("write", async (tx) => {
    const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id));
    if (row) await ensureUploadWork(tx, row);
    const [work] = await tx.select().from(driveUploadWork).where(eq(driveUploadWork.id, id));
    assertMutationGuardIdentity(work?.mutationGuardId ?? null);
    if (work?.status === "pending") {
      const referenced = await referencedObjectKeys(tx, [work.objectKey, ...(work.publicationKey ? [work.publicationKey] : [])]);
      if (referenced.size) await tx.update(driveUploadWork).set({ status: "published" }).where(eq(driveUploadWork.id, id));
    }
    return work;
  });
  if (!identity) {
    return withDriveTransaction("read", async (tx) => {
      const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id));
      if (!row || row.state !== "complete") throw new DriveError("This upload is no longer available.");
      await assertUploadAccess(tx, ctx, row);
      return itemData(tx, ctx, row);
    });
  }
  const result = await withStorageObjectLock(identity.objectKey, async (confirmClaim): Promise<Completion> => {
    const snapshot = await withDriveTransaction("write", async (tx) => {
      const [work] = await tx.select().from(driveUploadWork).where(eq(driveUploadWork.id, id));
      assertMutationGuardIdentity(work?.mutationGuardId ?? null);
      if (work?.status === "published") {
        const [file] = await tx.select().from(driveItems).where(eq(driveItems.id, work.itemId));
        if (!file || file.state !== "complete") throw new DriveError("This file is no longer available.");
        await assertUploadAccess(tx, ctx, file);
        return { item: await itemData(tx, ctx, file) };
      }
      const row = await pendingUpload(tx, ctx, id);
      // A different deployment may still write the original final key. Our
      // single-PUT candidate must be durable and disjoint before entering R2.
      const publicationKey = row.multipartUploadId ? row.objectKey! : work.publicationKey ?? createObjectKey(row.replacesId ?? row.id);
      if (!row.multipartUploadId && !work.publicationKey) await tx.update(driveUploadWork).set({ publicationKey }).where(eq(driveUploadWork.id, id));
      return { row, publicationKey };
    });
    if ("item" in snapshot) return { staged: null, item: snapshot.item!, replaced: null };
    const row = snapshot.row!;
    const publicationKey = snapshot.publicationKey!;
    const etag = await commitUpload(row, publicationKey);
    await confirmClaim();
    const published = await withDriveTransaction("write", async (tx): Promise<Completion> => {
      const current = await pendingUpload(tx, ctx, id);
      if (current.objectKey !== row.objectKey || current.multipartUploadId !== row.multipartUploadId) throw new DriveError("This upload has changed. Please try again.");
      await assertMutationGuard(tx, ctx, { operation: "upload", name: current.name, parentId: current.parentId, size: current.size, mimeType: current.mimeType!, pendingId: current.id });
      let completed: DriveRow;
      let replaced: ContentReplacement | null = null;
      if (current.replacesId) {
        const [file] = await tx.select().from(driveItems).where(eq(driveItems.id, current.replacesId));
        await tx.delete(driveItems).where(eq(driveItems.id, id));
        replaced = await replaceFileContent(tx, file, { objectKey: publicationKey, size: row.size, mimeType: row.mimeType!, etag, createdBy: row.createdBy });
        completed = replaced.file;
      } else {
        [completed] = await tx.update(driveItems).set({ objectKey: publicationKey, state: "complete", etag, updatedAt: new Date() }).where(eq(driveItems.id, id)).returning();
        await enqueueSearch(tx, [completed.id]);
      }
      await tx.update(driveUploadWork).set({ status: "published" }).where(eq(driveUploadWork.id, id));
      await tx.insert(driveActivity).values({ userId: ctx.userId, itemId: completed.id, accessedAt: new Date() })
        .onConflictDoUpdate({ target: [driveActivity.userId, driveActivity.itemId], set: { accessedAt: new Date() } });
      await recordEvents(tx, ctx, [{ action: replaced ? "new_version" : "upload", item: { id: completed.id, name: completed.name, kind: "file", parentId: completed.parentId },
        details: replaced ? { versionId: replaced.version.id, size: row.size } : { size: row.size } }]);
      await completeMutationGuard(tx, ctx, { itemIds: [completed.id], names: [completed.name] });
      return { staged: row, item: await itemData(tx, ctx, completed), replaced };
    });
    // Staging remains retryable through a failed publication, and disappears only after commit.
    await removeStagedObject(row).catch(() => undefined);
    return published;
  });
  if (result.replaced) await afterContentChange(result.item, result.replaced.pruned);
  else if (result.staged && !result.item.isProtected) after(() => prioritizeScans([result.item.id]));
  return result.item;
}

export async function cancelPendingUpload(ctx: DriveContext, id: string): Promise<void> {
  await withDriveTransaction("write", async (tx) => {
    const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id));
    if (!row) return;
    if (row.kind !== "file" || row.state !== "pending") throw new DriveError("This upload has already completed. Move the file to Trash instead.");
    await assertUploadAccess(tx, ctx, row, { allowTrashed: true });
    await ensureUploadWork(tx, row);
    await tx.update(driveUploadWork).set({ status: "cancelled" }).where(eq(driveUploadWork.id, id));
    await tx.update(driveItems).set({ deletionStartedAt: new Date() }).where(eq(driveItems.id, id));
  });
  // A concurrent completion observes the committed cancellation and cannot publish.
  // Busy/error cleanup retains the journal for the scheduled retry.
  await cleanupUpload(id).catch(() => undefined);
}

export type UploadFolderRequest = { key: string; name: string; parentId: string | null; parentKey?: string; resolution?: UploadResolution };
export type UploadFolderResult = { key: string; folder: DriveItem; created: boolean };

/** One bounded transaction preserves dependency mapping, permissions, depth checks and per-folder events. */
export async function ensureUploadFolders(ctx: DriveContext, requests: UploadFolderRequest[]): Promise<UploadFolderResult[]> {
  const { results, trashedUploadIds } = await withDriveTransaction("write", async (tx) => {
    const results: UploadFolderResult[] = [];
    const resolved = new Map<string, string>();
    const blocked = new Set<string>();
    const conflicts: DriveNameConflict[] = [];
    const trashedUploadIds: string[] = [];
    for (const request of requests) {
      if (request.parentKey && blocked.has(request.parentKey)) {
        blocked.add(request.key);
        continue;
      }
      const parentId = request.parentKey ? resolved.get(request.parentKey) : request.parentId;
      if (parentId === undefined) throw new DriveError("Upload folders must follow their parent folders.");
      const path = await uploadDestination(tx, ctx, parentId);
      const siblings = await destinationSiblings(tx, ctx, parentId);
      const existing = siblings.get(request.name.toLowerCase());
      if (existing?.kind === "folder") {
        const [folder] = await tx.select().from(driveItems).where(eq(driveItems.id, existing.id));
        await assertItemAccess(tx, ctx, folder, { permission: "write" });
        results.push({ key: request.key, folder: await itemData(tx, ctx, folder), created: false });
        resolved.set(request.key, folder.id);
        continue;
      }
      if (path.length >= MAX_FOLDER_DEPTH) throw new DriveError("Folders can be nested up to 64 levels deep.");
      let placement: Placement;
      try {
        placement = await placeIncoming(tx, ctx, { key: request.key, name: request.name, kind: "folder" }, parentId, siblings, request.resolution);
      } catch (error) {
        if (!(error instanceof NameConflictError)) throw error;
        conflicts.push(...error.conflicts);
        blocked.add(request.key);
        continue;
      }
      const [folder] = await tx.insert(driveItems).values({
        id: randomUUID(), name: placement.name, parentId, kind: "folder", state: "complete", size: 0, createdBy: ctx.userId,
        ownerId: ctx.userId, accessMode: parentId ? "inherit" : "private",
      }).returning();
      await recordEvents(tx, ctx, [{ action: "create_folder", item: { id: folder.id, name: folder.name, kind: "folder", parentId: folder.parentId } }]);
      trashedUploadIds.push(...placement.trashedUploadIds);
      results.push({ key: request.key, folder: await itemData(tx, ctx, folder), created: true });
      resolved.set(request.key, folder.id);
    }
    if (conflicts.length) throw new NameConflictError(conflicts);
    return { results, trashedUploadIds };
  });
  await cancelTrashedUploads(trashedUploadIds);
  return results;
}
