import "server-only";

import type { DriveTransaction } from "@/lib/db";
import type { ConflictResolution, ConflictResolutions, DriveNameConflict } from "@/lib/drive-types";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { driveItems } from "@/lib/drive-schema";
import { NameConflictError } from "@/lib/drive-errors";

export const conflictResolutionsSchema = z.record(z.string().max(128), z.enum(["replace", "keep-both", "skip"]))
  .optional().transform((value): ConflictResolutions => value ?? {});

export type DestinationSibling = { id: string; name: string; kind: "file" | "folder" };

/** Complete, non-trashed items directly inside `parentId`, keyed by lowercased name. */
export async function destinationSiblings(tx: DriveTransaction, parentId: string | null): Promise<Map<string, DestinationSibling>> {
  const rows = await tx.select({ id: driveItems.id, name: driveItems.name, kind: driveItems.kind }).from(driveItems).where(and(
    parentId ? eq(driveItems.parentId, parentId) : isNull(driveItems.parentId),
    eq(driveItems.state, "complete"),
    isNull(driveItems.trashedAt),
    sql`${driveItems.deletionStartedAt} is null`,
  ));
  const siblings = new Map<string, DestinationSibling>();
  for (const row of rows) if (!siblings.has(row.name.toLowerCase())) siblings.set(row.name.toLowerCase(), row);
  return siblings;
}

export type IncomingItem = { id: string; name: string; kind: "file" | "folder" };

/**
 * Pairs every incoming item with the sibling it collides with (case-insensitive name match),
 * ignoring an item colliding with itself (moving within the same folder).
 */
export function findConflicts(incoming: IncomingItem[], siblings: Map<string, DestinationSibling>): DriveNameConflict[] {
  const conflicts: DriveNameConflict[] = [];
  for (const item of incoming) {
    const existing = siblings.get(item.name.toLowerCase());
    if (existing && existing.id !== item.id) {
      conflicts.push({ id: item.id, name: item.name, kind: item.kind, existingId: existing.id, existingKind: existing.kind });
    }
  }
  return conflicts;
}

/**
 * Returns each conflict with its chosen resolution. Throws NameConflictError listing the conflicts
 * that have no resolution yet, so the client can ask and retry with all of them answered.
 */
export function resolveConflicts(conflicts: DriveNameConflict[], resolutions: ConflictResolutions): Map<string, { conflict: DriveNameConflict; resolution: ConflictResolution }> {
  const unanswered = conflicts.filter((conflict) => !resolutions[conflict.id]);
  if (unanswered.length) throw new NameConflictError(unanswered);
  return new Map(conflicts.map((conflict) => [conflict.id, { conflict, resolution: resolutions[conflict.id] }]));
}
