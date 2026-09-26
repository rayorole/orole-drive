import "server-only";

import { and, asc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { discoverableRootsCondition, tryItemsAccess, visibleItemsCondition, withDriveTransaction } from "@/lib/drive-access";
import type { DriveContext } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { driveItems } from "@/lib/drive-schema";
import { searchMetadataEligibility } from "@/lib/search-eligibility";
import { loadSearchNodes } from "@/lib/search-index";

const pageInput = {
  kind: z.enum(["all", "file", "folder"]).default("all"),
  ownerId: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(50).default(25),
  cursor: z.number().int().min(0).max(2_147_483_000).default(0).describe("Next cursor from the previous page; omit for the first page."),
};

export const listChatItemsInput = z.object({
  ...pageInput,
  folderId: z.uuid().nullable().optional().describe("Folder id from find_drive_items; omit for the drive root."),
});
export const findChatItemsInput = z.object({
  ...pageInput,
  query: z.string().trim().max(200).default("").describe("Case-insensitive part of a file or folder name. Empty with kind folder lists all accessible folders."),
});

type DiscoveryItem = { id: string; name: string; kind: "file" | "folder"; parentId: string | null; path: string[]; size: number; updatedAt: string };
export type ChatDiscoveryPage = { items: DiscoveryItem[]; folder: { id: string; name: string } | null; nextCursor: number | null };

/** Metadata only: no embeddings, extraction, or index readiness is needed. Each page is freshly authorized. */
export async function discoverChatItems(ctx: DriveContext, input: { mode: "list" | "find" } & z.input<typeof listChatItemsInput> & z.input<typeof findChatItemsInput>): Promise<ChatDiscoveryPage> {
  const parsed = input.mode === "list" ? listChatItemsInput.parse(input) : findChatItemsInput.parse(input);
  const { kind, ownerId, limit, cursor } = parsed;
  const folderId = "folderId" in parsed ? parsed.folderId : null;
  const query = "query" in parsed ? parsed.query : "";
  return withDriveTransaction("read", async (tx) => {
    let folder: ChatDiscoveryPage["folder"] = null;
    if (folderId) {
      const [row] = await tx.select({ id: driveItems.id, name: driveItems.name, kind: driveItems.kind }).from(driveItems).where(eq(driveItems.id, folderId));
      const nodes = await loadSearchNodes(tx, [folderId]);
      const access = await tryItemsAccess(tx, ctx, [folderId], { permission: "read" });
      if (!row || row.kind !== "folder" || !access.get(folderId) || !searchMetadataEligibility(nodes, folderId).eligible) {
        throw new DriveError("This folder is no longer available.");
      }
      folder = { id: row.id, name: row.name };
    }
    const conditions = [visibleItemsCondition(ctx), eq(driveItems.state, "complete"), isNull(driveItems.trashedAt), isNull(driveItems.deletionStartedAt)];
    if (kind !== "all") conditions.push(eq(driveItems.kind, kind));
    if (ownerId) conditions.push(eq(driveItems.ownerId, ownerId));
    if (query) conditions.push(ilike(driveItems.name, `%${query.replace(/[\\%_]/g, "\\$&")}%`));
    if (input.mode === "list") conditions.push(folderId ? eq(driveItems.parentId, folderId) : discoverableRootsCondition(ctx));
    const items: DiscoveryItem[] = [];
    let offset = cursor;
    let nextCursor: number | null = null;
    // Bound database work even when many otherwise-readable rows are excluded from AI.
    // Cursor advances over scanned rows, so an empty page with a cursor is not a claim of no matches.
    for (let batch = 0; batch < 5; batch++) {
      const rows = await tx.select().from(driveItems).where(and(...conditions))
        .orderBy(asc(sql`lower(${driveItems.name})`), asc(driveItems.id)).limit(101).offset(offset);
      const candidates = rows.slice(0, 100);
      const byId = new Map(candidates.map((row) => [row.id, row]));
      const ids = [...byId.keys()];
      const nodes = await loadSearchNodes(tx, ids);
      const access = await tryItemsAccess(tx, ctx, ids, { permission: "read" });
      const ancestorIds = [...nodes.keys()].filter((id) => !byId.has(id));
      const ancestorAccess = await tryItemsAccess(tx, ctx, ancestorIds, { permission: "read" });
      const readableAncestors = ancestorIds.filter((id) => ancestorAccess.get(id));
      const names = new Map(readableAncestors.length ? (await tx.select({ id: driveItems.id, name: driveItems.name }).from(driveItems).where(inArray(driveItems.id, readableAncestors))).map((row) => [row.id, row.name]) : []);
      for (let index = 0; index < candidates.length; index++) {
        const row = candidates[index];
        offset++;
        const flags = access.get(row.id);
        if (!flags || !searchMetadataEligibility(nodes, row.id).eligible) continue;
        const path: string[] = [];
        for (let parent = row.parentId; parent && path.length < 64; parent = nodes.get(parent)?.parentId ?? null) {
          // A parent may also be a candidate in this batch; never expose inaccessible ancestor names.
          const name = access.get(parent) ? byId.get(parent)?.name : names.get(parent);
          if (!name) break;
          path.unshift(name);
        }
        items.push({ id: row.id, name: row.name, kind: row.kind, parentId: flags.parentId, path, size: row.size, updatedAt: row.updatedAt.toISOString() });
        if (items.length === limit) return { items, folder, nextCursor: index + 1 < rows.length ? offset : null };
      }
      nextCursor = rows.length > candidates.length ? offset : null;
      if (nextCursor === null) break;
    }
    return { items, folder, nextCursor };
  });
}
