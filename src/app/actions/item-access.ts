"use server";

import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { user } from "@/lib/auth-schema";
import { isVerifiedFamilyUser } from "@/lib/auth-policy";
import { recordEvents } from "@/lib/activity";
import { assertItemAccess, driveAction, tryItemsAccess, withDriveTransaction } from "@/lib/drive-access";
import type { DriveContext, DriveTransaction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { idSchema } from "@/lib/drive-input";
import { driveItemMembers, driveItems } from "@/lib/drive-schema";
import type { DriveRow } from "@/lib/drive-schema";
import { folderPath } from "@/lib/drive-tree";
import type { ActionResult, DriveAccessMode, ItemSharing, ShareMember } from "@/lib/drive-types";

const roleSchema = z.enum(["viewer", "editor"]);
const sharingSchema = z.object({
  id: idSchema,
  accessMode: z.enum(["private", "inherit", "members", "selected"]),
  memberRole: roleSchema,
  members: z.array(z.object({ userId: z.string().min(1).max(255), role: roleSchema })).max(1000),
  revokePublic: z.boolean().optional(),
}).refine((input) => new Set(input.members.map((member) => member.userId)).size === input.members.length, "Choose each member only once.");

async function managedItem(tx: DriveTransaction, ctx: DriveContext, id: string): Promise<DriveRow> {
  const [row] = await tx.select().from(driveItems).where(and(eq(driveItems.id, id), eq(driveItems.state, "complete")));
  if (!row) throw new DriveError("This file or folder is no longer available.");
  await assertItemAccess(tx, ctx, row, { permission: "manage" });
  return row;
}

async function sharingData(tx: DriveTransaction, ctx: DriveContext, row: DriveRow): Promise<ItemSharing> {
  const members = await tx.select({ id: user.id, name: user.name, email: user.email, role: driveItemMembers.role })
    .from(driveItemMembers).innerJoin(user, eq(user.id, driveItemMembers.userId))
    .where(eq(driveItemMembers.itemId, row.id)).orderBy(asc(user.name), asc(user.id));
  let inheritedFrom: ItemSharing["inheritedFrom"] = null;
  if (row.accessMode === "inherit" && row.parentId) {
    const path = await folderPath(tx, row.parentId);
    const source = path.findLast((ancestor) => ancestor.accessMode !== "inherit" || ancestor.ownerId === ctx.userId);
    if (source && (await tryItemsAccess(tx, ctx, [source.id])).get(source.id)) inheritedFrom = { id: source.id, name: source.name };
  }
  return { accessMode: row.accessMode, memberRole: row.memberRole, members, inheritedFrom, hasParent: row.parentId !== null, canManage: true };
}

/** The picker only exposes registered, verified drive accounts, never arbitrary email invitations. */
export async function listShareMembers(): Promise<ActionResult<ShareMember[]>> {
  return driveAction(() => withDriveTransaction("read", async (tx) => {
    const members = await tx.select({ id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified })
      .from(user).where(eq(user.emailVerified, true)).orderBy(asc(user.name), asc(user.id));
    return members.filter(isVerifiedFamilyUser).map(({ id, name, email }) => ({ id, name, email }));
  }), "read");
}

/** Grant identities are owner-only; nonowners already receive their effective role in DriveItem. */
export async function getItemSharing(id: string): Promise<ActionResult<ItemSharing>> {
  return driveAction((ctx) => withDriveTransaction("read", async (tx) => sharingData(tx, ctx, await managedItem(tx, ctx, idSchema.parse(id)))), "read");
}

export async function setItemSharing(input: {
  id: string;
  accessMode: DriveAccessMode;
  memberRole: "viewer" | "editor";
  members: { userId: string; role: "viewer" | "editor" }[];
  revokePublic?: boolean;
}): Promise<ActionResult<ItemSharing>> {
  return driveAction(async (ctx) => {
    const parsed = sharingSchema.parse(input);
    return withDriveTransaction("write", async (tx) => {
      const row = await managedItem(tx, ctx, parsed.id);
      if (parsed.accessMode === "inherit" && !row.parentId) throw new DriveError("Items at the top level cannot inherit folder access.");
      const grants = parsed.accessMode === "selected" ? parsed.members : [];
      if (grants.length) {
        const accounts = await tx.select({ id: user.id, email: user.email, emailVerified: user.emailVerified }).from(user)
          .where(inArray(user.id, grants.map((member) => member.userId))).for("share");
        if (accounts.length !== grants.length || accounts.some((account) => !isVerifiedFamilyUser(account))) {
          throw new DriveError("Choose registered, verified drive members.");
        }
      }
      const [updated] = await tx.update(driveItems).set({
        accessMode: parsed.accessMode,
        memberRole: parsed.memberRole,
        ...(parsed.revokePublic ? { publicToken: null, publicExpiresAt: null, sharedByEmail: null } : {}),
        updatedAt: new Date(),
      }).where(eq(driveItems.id, row.id)).returning();
      await tx.delete(driveItemMembers).where(eq(driveItemMembers.itemId, row.id));
      if (grants.length) await tx.insert(driveItemMembers).values(grants.map((member) => ({ itemId: row.id, userId: member.userId, role: member.role })));
      await recordEvents(tx, ctx, [{
        action: parsed.accessMode === "private" ? "unshare" : "share",
        item: row,
        details: { accessMode: parsed.accessMode, publicRevoked: Boolean(parsed.revokePublic && row.publicToken) },
      }]);
      return sharingData(tx, ctx, updated);
    });
  }, "share");
}
