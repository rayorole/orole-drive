import "server-only";

import type { DriveContext } from "@/lib/drive-access";
import type { DriveTransaction } from "@/lib/db";
import { sql } from "drizzle-orm";
import { DRIVE_EVENT_ACTIONS, driveEvents } from "@/lib/drive-schema";
import type { DriveEventRow } from "@/lib/drive-schema";

export type DriveEventAction = (typeof DRIVE_EVENT_ACTIONS)[number];
export type DriveEventDetails = Record<string, string | number | boolean | null>;

export type NewDriveEvent = {
  action: DriveEventAction;
  /** The item as it is after the event (its current name and parent). `id: null` for drive-wide events like emptying Trash. */
  item: { id: string | null; name: string; kind: "file" | "folder"; parentId: string | null };
  details?: DriveEventDetails;
};

/** Scheduled cleanup acts as this actor, so its deletions never pose as a member's. */
export const SYSTEM_ACTOR = { userId: null, email: "Automatic cleanup" } as const;

/** Historical links are untrusted snapshots, not proof the referenced item is still readable. */
export function activityReferenceIds(event: Pick<DriveEventRow, "itemId" | "parentId" | "details">): string[] {
  return [...new Set([event.itemId, event.parentId, event.details.fromParentId, event.details.sourceId]
    .filter((id): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))];
}

/**
 * AI history uses current authorized names, never historical names or arbitrary detail text.
 * A moved/copied item's old location can be private, excluded, protected or deleted today.
 */
export function chatActivityDetails(
  event: Pick<DriveEventRow, "parentId" | "details">,
  readable: (id: string) => { id: string; name: string } | undefined,
): DriveEventDetails {
  const details: DriveEventDetails = {};
  for (const key of ["size", "count", "bytes"] as const) {
    const value = event.details[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) details[key] = value;
  }
  for (const key of ["publicRevoked", "restoredToRoot"] as const) {
    if (typeof event.details[key] === "boolean") details[key] = event.details[key];
  }
  const fromId = event.details.fromParentId;
  const from = typeof fromId === "string" ? readable(fromId) : undefined;
  if (from) {
    details.fromParentId = from.id;
    details.fromParentName = from.name;
  }
  const to = event.parentId ? readable(event.parentId) : undefined;
  if (to) details.toParentName = to.name;
  const sourceId = event.details.sourceId;
  const source = typeof sourceId === "string" ? readable(sourceId) : undefined;
  if (source) details.sourceId = source.id;
  return details;
}

/**
 * Appends events to the shared activity history inside the caller's transaction, so an event exists
 * exactly when its change commits. Items inside (or being) a password-protected folder are flagged
 * so the feed can redact them for members who haven't unlocked that folder.
 */
export async function recordEvents(tx: DriveTransaction, ctx: Pick<DriveContext, "email"> & { userId: string | null }, events: NewDriveEvent[]): Promise<void> {
  if (!events.length) return;
  // Locked folders' own names are visible in listings; only what sits inside one is redacted.
  const startIds = [...new Set(events.map((event) => event.item.parentId).filter((id): id is string => Boolean(id)))];
  const protectedIds = new Set<string>();
  if (startIds.length) {
    // For every parent folder, whether it or any ancestor has a password.
    const rows = await tx.execute<{ start_id: string }>(sql`
      with recursive chain(start_id, id, parent_id, protected, depth) as (
        select item.id, item.id, item.parent_id, item.password_hash is not null, 0
        from drive_items item where item.id in (${sql.join(startIds.map((id) => sql`${id}::uuid`), sql`, `)})
        union all
        select chain.start_id, parent.id, parent.parent_id, parent.password_hash is not null, chain.depth + 1
        from drive_items parent join chain on parent.id = chain.parent_id
        where chain.depth < 64
      ) select distinct start_id from chain where protected
    `);
    for (const row of rows) protectedIds.add(row.start_id);
  }
  const now = new Date();
  await tx.insert(driveEvents).values(events.map((event) => ({
    at: now,
    actorId: ctx.userId,
    actorEmail: ctx.email,
    action: event.action,
    itemId: event.item.id,
    itemName: event.item.name,
    itemKind: event.item.kind,
    parentId: event.item.parentId,
    details: event.details ?? {},
    protected: Boolean(event.item.parentId && protectedIds.has(event.item.parentId)),
  })));
}
