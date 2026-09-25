"use server";

import type { DriveContext, DriveTransaction } from "@/lib/drive-access";
import type { DriveFileVersionRow, DriveRow } from "@/lib/drive-schema";
import type { ActionResult, DriveFileVersion, DriveItem } from "@/lib/drive-types";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordEvents } from "@/lib/activity";
import { user } from "@/lib/auth-schema";
import { assertItemAccess, driveAction, withDriveTransaction } from "@/lib/drive-access";
import { idSchema } from "@/lib/drive-input";
import { DriveError } from "@/lib/drive-errors";
import { driveFileVersions, driveItems } from "@/lib/drive-schema";
import { afterContentChange, replaceFileContent } from "@/lib/file-versions";
import { cleanupVersion, queueVersionCleanup, signVersionDownload } from "@/lib/storage";
import { itemData, uploadDestination } from "@/lib/uploads";

const versionIdSchema = z.uuid("Choose a valid version.");

/** A version and its file, when the file is available (complete, not in Trash) with the required current access. */
async function availableVersion(tx: DriveTransaction, ctx: DriveContext, versionId: string, permission: "read" | "write" = "read"): Promise<{ version: DriveFileVersionRow; file: DriveRow }> {
  const [version] = await tx.select().from(driveFileVersions).where(eq(driveFileVersions.id, versionId));
  if (!version) throw new DriveError("This version is no longer available.");
  const [file] = await tx.select().from(driveItems).where(eq(driveItems.id, version.itemId));
  if (!file || file.state !== "complete" || file.trashedAt || file.deletionStartedAt) throw new DriveError("This file is in Trash or is no longer available.");
  await assertItemAccess(tx, ctx, file, { permission });
  return { version, file };
}

/** The file's current content followed by its earlier versions, newest first. Files in Trash can be listed. */
export async function listVersions(itemId: string): Promise<ActionResult<DriveFileVersion[]>> {
  return driveAction(async (ctx) => {
    itemId = idSchema.parse(itemId);
    return withDriveTransaction("read", async (tx) => {
      const [file] = await tx.select().from(driveItems).where(eq(driveItems.id, itemId));
      if (!file || file.kind !== "file" || file.state !== "complete") throw new DriveError("This file is no longer available.");
      await assertItemAccess(tx, ctx, file, { allowTrashed: true });
      const [uploader] = file.createdBy ? await tx.select({ email: user.email }).from(user).where(eq(user.id, file.createdBy)) : [];
      const versions = await tx.select({ version: driveFileVersions, email: user.email }).from(driveFileVersions)
        .leftJoin(user, eq(user.id, driveFileVersions.createdBy))
        .where(eq(driveFileVersions.itemId, file.id))
        .orderBy(desc(driveFileVersions.replacedAt), desc(driveFileVersions.createdAt));
      return [
        { id: file.id, current: true, size: file.size, mimeType: file.mimeType, createdAt: file.updatedAt.toISOString(), replacedAt: null, createdByEmail: uploader?.email ?? null },
        ...versions.map(({ version, email }) => ({
          id: version.id, current: false, size: version.size, mimeType: version.mimeType,
          createdAt: version.createdAt.toISOString(), replacedAt: version.replacedAt.toISOString(), createdByEmail: email,
        })),
      ];
    });
  }, "read");
}

export async function getVersionDownloadUrl(versionId: string): Promise<ActionResult<{ url: string }>> {
  return driveAction(async (ctx) => {
    versionId = versionIdSchema.parse(versionId);
    return withDriveTransaction("read", async (tx) => {
      const { version, file } = await availableVersion(tx, ctx, versionId);
      return { url: await signVersionDownload(version, file.name) };
    });
  }, "read");
}

/** Makes an earlier version current again; the content it replaces becomes a version, so nothing is lost. */
export async function restoreVersion(versionId: string): Promise<ActionResult<DriveItem>> {
  return driveAction(async (ctx) => {
    versionId = versionIdSchema.parse(versionId);
    const result = await withDriveTransaction("write", async (tx) => {
      const { version, file } = await availableVersion(tx, ctx, versionId, "write");
      await uploadDestination(tx, ctx, file.parentId);
      await tx.delete(driveFileVersions).where(eq(driveFileVersions.id, version.id));
      const replaced = await replaceFileContent(tx, file, { objectKey: version.objectKey, size: version.size, mimeType: version.mimeType, etag: version.etag, createdBy: version.createdBy });
      await recordEvents(tx, ctx, [{ action: "restore_version", item: { id: file.id, name: file.name, kind: "file", parentId: file.parentId }, details: { versionId: version.id, size: version.size } }]);
      return { item: await itemData(tx, ctx, replaced.file), pruned: replaced.pruned };
    });
    await afterContentChange(result.item, result.pruned);
    return result.item;
  });
}

export async function deleteVersion(versionId: string): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    versionId = versionIdSchema.parse(versionId);
    const version = await withDriveTransaction("write", async (tx) => {
      const { version, file } = await availableVersion(tx, ctx, versionId, "write");
      await queueVersionCleanup(tx, version);
      await tx.delete(driveFileVersions).where(eq(driveFileVersions.id, version.id));
      await recordEvents(tx, ctx, [{ action: "delete_version", item: { id: file.id, name: file.name, kind: "file", parentId: file.parentId }, details: { versionId: version.id, size: version.size } }]);
      return version;
    });
    // A thumbnail worker may still hold this immutable content; cleanup retries from the journal.
    await cleanupVersion(version).catch(() => undefined);
  }, "trash");
}
