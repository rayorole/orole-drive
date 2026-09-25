"use server";

import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { user } from "@/lib/auth-schema";
import { assertItemAccess, driveAction, tryItemsAccess, visibleItemsCondition, withDriveTransaction } from "@/lib/drive-access";
import { DRIVE_EVENT_ACTIONS, driveEvents, driveFavorites, driveItems } from "@/lib/drive-schema";
import { DriveError } from "@/lib/drive-errors";
import type { ActionResult, DriveActivityAction, DriveActivityEvent, DriveActivityMember, DriveActivityPage } from "@/lib/drive-types";
import { toDriveItem } from "@/lib/storage";

const idSchema = z.uuid("Choose a valid file or folder.");

/**
 * History is available only while its item remains readable under the current ACL.
 * Historical references to other items are independently checked against current access.
 */
export async function listActivity(input: {
  cursor?: string | null; limit?: number; itemId?: string; folderId?: string; actorId?: string; actions?: DriveActivityAction[];
} = {}): Promise<ActionResult<DriveActivityPage>> {
  return driveAction(async (ctx) => {
    const { cursor, limit, itemId, folderId, actorId, actions } = z.object({
      cursor: z.uuid().nullish(),
      limit: z.number().int().min(1).max(100).default(50),
      itemId: idSchema.optional(),
      folderId: idSchema.optional(),
      actorId: z.string().min(1).max(255).optional(),
      actions: z.array(z.enum(DRIVE_EVENT_ACTIONS)).max(DRIVE_EVENT_ACTIONS.length).optional(),
    }).parse(input);
    return withDriveTransaction("read", async (tx) => {
      // History is not an index of private or permanently deleted items.
      for (const [id, includeSelf] of [[itemId, false], [folderId, true]] as const) {
        if (!id) continue;
        const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id));
        if (!row) throw new DriveError("This file or folder is no longer available.");
        await assertItemAccess(tx, ctx, row, { allowTrashed: true, includeSelf, permission: "read" });
      }
      const conditions: SQL[] = [
        eq(driveItems.state, "complete"), isNull(driveItems.deletionStartedAt), visibleItemsCondition(ctx, { trash: true }),
      ];
      // Keyset on (at, id): stable while new events arrive, unlike offsets.
      if (cursor) conditions.push(sql`(${driveEvents.at}, ${driveEvents.id}) < (select at, id from drive_events where id = ${cursor}::uuid)`);
      if (itemId) conditions.push(eq(driveEvents.itemId, itemId));
      if (folderId) conditions.push(eq(driveEvents.parentId, folderId));
      if (actorId) conditions.push(eq(driveEvents.actorId, actorId));
      if (actions?.length) conditions.push(inArray(driveEvents.action, actions));
      const found = await tx.select({ event: driveEvents, actorName: user.name, actorAccountEmail: user.email })
        .from(driveEvents).innerJoin(driveItems, eq(driveItems.id, driveEvents.itemId)).leftJoin(user, eq(user.id, driveEvents.actorId))
        .where(and(...conditions)).orderBy(desc(driveEvents.at), desc(driveEvents.id)).limit(limit + 1);
      const page = found.slice(0, limit);

      const referenced = new Set<string>();
      for (const { event } of page) {
        if (event.itemId) referenced.add(event.itemId);
        if (event.parentId) referenced.add(event.parentId);
        if (typeof event.details.fromParentId === "string") referenced.add(event.details.fromParentId);
        if (typeof event.details.sourceId === "string") referenced.add(event.details.sourceId);
      }
      const rows = new Map(referenced.size ? (await tx.select().from(driveItems).where(inArray(driveItems.id, [...referenced]))).map((row) => [row.id, row]) : []);
      // Password-protected folders may expose their own name, never their descendants.
      const access = await tryItemsAccess(tx, ctx, [...rows.keys()], { allowTrashed: true, includeSelf: false, permission: "read" });
      const reachable = (id: string | null | undefined) => {
        const row = id ? rows.get(id) : undefined;
        return row && row.state === "complete" && !row.deletionStartedAt && access.get(row.id) ? row : undefined;
      };
      const availableIds = page.flatMap(({ event }) => {
        const row = reachable(event.itemId);
        return row && !row.trashedAt ? [row.id] : [];
      });
      const favorites = availableIds.length ? new Set((await tx.select({ id: driveFavorites.itemId }).from(driveFavorites)
        .where(and(eq(driveFavorites.userId, ctx.userId), inArray(driveFavorites.itemId, availableIds)))).map((row) => row.id)) : new Set<string>();

      const events = page.flatMap(({ event, actorName, actorAccountEmail }): DriveActivityEvent[] => {
        const row = reachable(event.itemId);
        if (!row) return [];
        // Members without an account row left (or the scheduled cleanup) keep their logged label.
        const email = actorAccountEmail ?? (event.actorEmail.includes("@") ? event.actorEmail : null);
        const actor = { id: event.actorId, name: actorName || email?.split("@")[0] || event.actorEmail, email };
        const parentRow = reachable(event.parentId);
        const details = { ...event.details };
        if (typeof details.fromParentId === "string" && !reachable(details.fromParentId)) {
          delete details.fromParentId;
          delete details.fromParentName;
        }
        if (event.parentId && !parentRow) delete details.toParentName;
        if (typeof details.sourceId === "string" && !reachable(details.sourceId)) delete details.sourceId;
        return [{
          id: event.id, at: event.at.toISOString(), action: event.action, actor,
          item: { id: row.id, name: event.itemName, kind: event.itemKind, redacted: false, status: row.trashedAt ? "trashed" : "available" },
          current: !row.trashedAt ? { ...toDriveItem(row), ...access.get(row.id)!, isFavorite: favorites.has(row.id) } : null,
          parent: !event.parentId ? { id: null, name: "All files", trashed: false } : parentRow ? { id: parentRow.id, name: parentRow.name, trashed: Boolean(parentRow.trashedAt) } : null,
          details,
        }];
      });
      return { events, nextCursor: found.length > limit ? page[page.length - 1].event.id : null };
    });
  }, "read");
}

/** Members appearing in history the caller can currently read. */
export async function listActivityMembers(): Promise<ActionResult<DriveActivityMember[]>> {
  return driveAction((ctx) => withDriveTransaction("read", async (tx) => {
    const members = await tx.selectDistinct({ id: user.id, name: user.name, email: user.email }).from(user)
      .innerJoin(driveEvents, eq(driveEvents.actorId, user.id))
      .innerJoin(driveItems, eq(driveItems.id, driveEvents.itemId))
      .where(and(eq(driveItems.state, "complete"), isNull(driveItems.deletionStartedAt), visibleItemsCondition(ctx, { trash: true })))
      .orderBy(asc(user.name), asc(user.email));
    return members.map((member) => ({ ...member, name: member.name || member.email.split("@")[0] }));
  }), "read");
}
