"use server";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertItemAccess, assertItemsAccess, driveAction, withDriveTransaction } from "@/lib/drive-access";
import type { DriveContext, DriveTransaction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { driveFolderUnlocks, driveItems } from "@/lib/drive-schema";
import type { DriveRow } from "@/lib/drive-schema";
import type { ActionResult } from "@/lib/drive-types";
import { hashFolderPassword, isValidFolderPassword, verifyFolderPassword } from "@/lib/folder-password";
import { recordEvents } from "@/lib/activity";
import { loadTree } from "@/lib/drive-tree";
import { enqueueSearchTree, removeFromSearch } from "@/lib/search-index";
import { consumeThrottle } from "@/lib/throttle";

const idSchema = z.uuid("Choose a valid folder.");
const passwordSchema = z.string().max(1_024, "Use a password up to 1,024 bytes long.").refine(
  isValidFolderPassword,
  "Enter a password up to 1,024 bytes long, without invalid Unicode characters.",
);

async function loadFolder(tx: DriveTransaction, id: string): Promise<DriveRow> {
  const [folder] = await tx.select().from(driveItems).where(and(
    eq(driveItems.id, id), eq(driveItems.kind, "folder"), eq(driveItems.state, "complete"),
  )).for("update");
  if (!folder) throw new DriveError("This folder is no longer available.");
  return folder;
}

async function consumePasswordAttempt(tx: DriveTransaction, ctx: DriveContext, folderId: string): Promise<void> {
  const limits = [
    { key: "folder-password:global", max: 60 },
    { key: `folder-password:folder:${folderId}`, max: 20 },
    { key: `folder-password:user:${ctx.userId}:${folderId}`, max: 5 },
  ];
  for (const limit of limits) {
    if (!await consumeThrottle(tx, limit.key, limit.max, 15 * 60)) throw new DriveError("Too many folder password attempts. Wait 15 minutes and try again.");
  }
}

async function grantFolder(tx: DriveTransaction, ctx: DriveContext, folderId: string, passwordVersion: string): Promise<void> {
  const expiresAt = sql`least(clock_timestamp() + interval '1 hour', (
    select expires_at from auth_session where id = ${ctx.sessionId}
  ))`;
  await tx.insert(driveFolderUnlocks).values({
    sessionId: ctx.sessionId, folderId, passwordVersion, expiresAt,
  }).onConflictDoUpdate({
    target: [driveFolderUnlocks.sessionId, driveFolderUnlocks.folderId],
    set: { passwordVersion, expiresAt },
  });
}

export async function unlockFolder(input: { id: string; password: string }): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    const { id, password } = z.object({ id: idSchema, password: passwordSchema }).parse(input);
    const unlocked = await withDriveTransaction("write", async (tx) => {
      const folder = await loadFolder(tx, id);
      await assertItemAccess(tx, ctx, folder, { allowTrashed: true, includeSelf: false });
      if (!folder.passwordHash) return true;
      if (!folder.passwordVersion) throw new DriveError("This folder's password is unavailable. Contact the drive administrator.");
      await consumePasswordAttempt(tx, ctx, id);
      // Return a failed verification rather than throwing inside the transaction:
      // failed attempts must commit their rate-limit buckets.
      if (!await verifyFolderPassword(password, folder.passwordHash)) return false;
      await grantFolder(tx, ctx, id, folder.passwordVersion);
      return true;
    });
    if (!unlocked) throw new DriveError("That folder password is incorrect.");
  });
}

export async function setFolderPassword(input: { id: string; password: string | null }): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    const { id, password } = z.object({
      id: idSchema,
      password: passwordSchema.refine((value) => value.length >= 8, "Use at least 8 characters for the folder password.").nullable(),
    }).parse(input);
    await withDriveTransaction("write", async (tx) => {
      const folder = await loadFolder(tx, id);
      // Changing or removing existing protection always requires its current grant.
      await assertItemAccess(tx, ctx, folder, { allowTrashed: true, permission: "manage" });
      if (folder.deletionStartedAt) throw new DriveError("This folder is being permanently deleted.");
      if (password === null && folder.passwordHash === null) return;
      // Protection and public-link revocation affect the full subtree, never a hidden private child.
      await assertItemsAccess(tx, ctx, (await loadTree(tx, [id])).rows, { allowTrashed: true, permission: "write" });
      if (password !== null) await consumePasswordAttempt(tx, ctx, id);
      const passwordHash = password === null ? null : await hashFolderPassword(password);
      const passwordVersion = password === null ? null : randomUUID();
      if (passwordHash !== null) {
        await tx.update(driveItems).set({ publicToken: null, sharedByEmail: null, publicExpiresAt: null }).where(sql`${driveItems.id} in (
          with recursive subtree as (
            select id from drive_items where id = ${id}::uuid
            union
            select child.id from drive_items child join subtree on child.parent_id = subtree.id
          ) select id from subtree
        )`);
      }
      await tx.update(driveItems).set({ passwordHash, passwordVersion, updatedAt: new Date() }).where(eq(driveItems.id, id));
      // Protected contents are never searchable, even while unlocked: drop them in this transaction.
      if (passwordHash !== null) await removeFromSearch(tx, [id], "protected");
      else await enqueueSearchTree(tx, [id]);
      await tx.delete(driveFolderUnlocks).where(eq(driveFolderUnlocks.folderId, id));
      if (passwordVersion) await grantFolder(tx, ctx, id, passwordVersion);
      const item = { id, name: folder.name, kind: "folder" as const, parentId: folder.parentId };
      await recordEvents(tx, ctx, [passwordHash === null ? { action: "unprotect", item } : { action: "protect", item, details: folder.passwordHash === null ? undefined : { passwordChanged: true } }]);
    });
  });
}

export async function lockFolder(id: string): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    const folderId = idSchema.parse(id);
    await withDriveTransaction("write", async (tx) => {
      const folder = await loadFolder(tx, folderId);
      await assertItemAccess(tx, ctx, folder, { allowTrashed: true, includeSelf: false });
      // Relocking a parent also drops this session's nested grants. Reopening the
      // parent must not silently reopen a separately protected descendant.
      await tx.delete(driveFolderUnlocks).where(and(
        eq(driveFolderUnlocks.sessionId, ctx.sessionId),
        sql`${driveFolderUnlocks.folderId} in (
          with recursive subtree as (
            select id from drive_items where id = ${folderId}::uuid
            union
            select child.id from drive_items child join subtree on child.parent_id = subtree.id
          ) select id from subtree
        )`,
      ));
    });
  });
}
