import "server-only";

import { tool } from "ai";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { activityReferenceIds, chatActivityDetails } from "@/lib/activity";
import type { DriveEventDetails } from "@/lib/activity";
import { user } from "@/lib/auth-schema";
import { chatDateRangeError, chatDateRangeFields, validChatDateRange } from "@/lib/chat-browse-input";
import { discoverChatItems, recentChatItemsInput } from "@/lib/chat-discovery";
import type { ChatToolContext } from "@/lib/chat-tool-context";
import { tryItemsAccess, visibleItemsCondition, withDriveTransaction } from "@/lib/drive-access";
import type { DriveContext } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { DRIVE_EVENT_ACTIONS, driveEvents, driveItems } from "@/lib/drive-schema";
import type { DriveChatTree, DriveChatTreeNode } from "@/lib/drive-types";
import { searchMetadataEligibility } from "@/lib/search-eligibility";
import { loadSearchNodes } from "@/lib/search-index";

export const chatActivityInput = z.object({
  ...chatDateRangeFields,
  ownerId: z.string().min(1).max(64).optional().describe("Current item owner, not the actor who performed the event. Must be a mentioned member."),
  itemId: z.uuid().optional(),
  folderId: z.uuid().optional().describe("Historical parent folder; does not include descendants."),
  actions: z.array(z.enum(DRIVE_EVENT_ACTIONS)).max(DRIVE_EVENT_ACTIONS.length).optional(),
  limit: z.number().int().min(1).max(50).default(25),
  cursor: z.uuid().optional().describe("nextCursor from the previous page with the same filters."),
}).refine(validChatDateRange, chatDateRangeError);

export const chatTreeInput = z.object({
  folderId: z.uuid().nullable().optional().describe("Authorized folder id to show; omit for the whole visible drive."),
  maxDepth: z.number().int().min(1).max(12).default(6),
  maxNodes: z.number().int().min(1).max(200).default(120),
});

/** Current authorization applies to every historical item AND each historical reference. */
export async function discoverChatActivity(ctx: DriveContext, input: z.input<typeof chatActivityInput>) {
  const parsed = chatActivityInput.parse(input);
  return withDriveTransaction("read", async (tx) => {
    const requested = [parsed.itemId, parsed.folderId].filter((id): id is string => Boolean(id));
    const requestedNodes = await loadSearchNodes(tx, requested);
    const requestedAccess = await tryItemsAccess(tx, ctx, requested, { permission: "read" });
    for (const id of requested) {
      if (!requestedAccess.get(id) || !searchMetadataEligibility(requestedNodes, id).eligible || (id === parsed.folderId && requestedNodes.get(id)?.kind !== "folder")) {
        throw new DriveError("This file or folder is no longer available.");
      }
    }
    const conditions = [visibleItemsCondition(ctx), eq(driveItems.state, "complete"), isNull(driveItems.trashedAt), isNull(driveItems.deletionStartedAt), eq(driveEvents.protected, false)];
    if (parsed.ownerId) conditions.push(eq(driveItems.ownerId, parsed.ownerId));
    if (parsed.itemId) conditions.push(eq(driveEvents.itemId, parsed.itemId));
    if (parsed.folderId) conditions.push(eq(driveEvents.parentId, parsed.folderId));
    if (parsed.actions?.length) conditions.push(inArray(driveEvents.action, parsed.actions));
    if (parsed.since) conditions.push(gte(driveEvents.at, new Date(parsed.since)));
    if (parsed.until) conditions.push(lt(driveEvents.at, new Date(parsed.until)));
    type Event = {
      id: string; at: string; action: (typeof DRIVE_EVENT_ACTIONS)[number];
      actor: { id: string | null; name: string };
      item: { id: string; name: string; kind: "file" | "folder" };
      parent: { id: string; name: string } | null;
      details: DriveEventDetails;
      references: { id: string; name: string }[];
    };
    const events: Event[] = [];
    let cursor = parsed.cursor;
    let nextCursor: string | null = null;
    // A bounded scan may legitimately return no visible events and still have a next page.
    for (let batch = 0; batch < 5; batch++) {
      const after = cursor ? sql`(${driveEvents.at}, ${driveEvents.id}) < (select at, id from drive_events where id = ${cursor}::uuid)` : undefined;
      const found = await tx.select({ event: driveEvents, actorName: user.name })
        .from(driveEvents).innerJoin(driveItems, eq(driveItems.id, driveEvents.itemId)).leftJoin(user, eq(user.id, driveEvents.actorId))
        .where(and(...conditions, after)).orderBy(desc(driveEvents.at), desc(driveEvents.id)).limit(101);
      const candidates = found.slice(0, 100);
      const ids = [...new Set(candidates.flatMap(({ event }) => activityReferenceIds(event)))];
      const nodes = await loadSearchNodes(tx, ids);
      const access = await tryItemsAccess(tx, ctx, ids, { permission: "read" });
      const rows = new Map(ids.length ? (await tx.select({ id: driveItems.id, name: driveItems.name, kind: driveItems.kind }).from(driveItems).where(inArray(driveItems.id, ids))).map((row) => [row.id, row]) : []);
      const readable = (id: string) => access.get(id) && searchMetadataEligibility(nodes, id).eligible ? rows.get(id) : undefined;
      for (let index = 0; index < candidates.length; index++) {
        const { event, actorName } = candidates[index];
        cursor = event.id;
        const item = event.itemId ? readable(event.itemId) : undefined;
        if (!item) continue;
        const parent = event.parentId ? readable(event.parentId) : undefined;
        const references = activityReferenceIds(event).flatMap((id) => {
          const row = readable(id);
          return row ? [{ id: row.id, name: row.name }] : [];
        });
        events.push({
          id: event.id, at: event.at.toISOString(), action: event.action,
          actor: { id: event.actorId, name: actorName || event.actorEmail },
          item, parent: parent ? { id: parent.id, name: parent.name } : null,
          details: chatActivityDetails(event, readable), references,
        });
        if (events.length === parsed.limit) return { events, nextCursor: index + 1 < found.length ? cursor : null };
      }
      nextCursor = found.length > candidates.length ? cursor ?? null : null;
      if (nextCursor === null) break;
    }
    return { events, nextCursor };
  });
}

/** Traverse real listings (including empty folders); never ask a model to invent structure. */
export async function discoverChatTree(ctx: DriveContext, input: z.input<typeof chatTreeInput>, signal?: AbortSignal): Promise<DriveChatTree> {
  const { folderId, maxDepth, maxNodes } = chatTreeInput.parse(input);
  const ids = new Set<string>();
  const pending: { folderId: string | null; depth: number; cursor: number }[] = [{ folderId: folderId ?? null, depth: 0, cursor: 0 }];
  let title = "Drive structure";
  let hasMore = false;
  if (folderId) ids.add(folderId);
  for (let pageCount = 0; pending.length && pageCount < 40; pageCount++) {
    signal?.throwIfAborted();
    const current = pending.shift()!;
    // Probe even at a node boundary so an actually empty folder can still be complete.
    const page = await discoverChatItems(ctx, { mode: "list", folderId: current.folderId, cursor: current.cursor, limit: Math.min(50, Math.max(1, maxNodes - ids.size)) });
    if (current.folderId === folderId && page.folder) title = page.folder.name;
    for (const item of page.items) {
      if (ids.has(item.id)) continue;
      if (ids.size >= maxNodes) { hasMore = true; break; }
      ids.add(item.id);
      if (item.kind === "folder") {
        if (current.depth + 1 < maxDepth) pending.push({ folderId: item.id, depth: current.depth + 1, cursor: 0 });
        else hasMore = true;
      }
    }
    if (page.nextCursor !== null) pending.push({ ...current, cursor: page.nextCursor });
    if (ids.size >= maxNodes && pending.length) { hasMore = true; break; }
  }
  hasMore ||= pending.length > 0;
  // Listing pages use separate transactions: refresh the accumulated snapshot after traversal.
  return withDriveTransaction("read", async (tx) => {
    const allIds = [...ids];
    const searchNodes = await loadSearchNodes(tx, allIds);
    const access = await tryItemsAccess(tx, ctx, allIds, { permission: "read" });
    const rows = allIds.length ? await tx.select({ id: driveItems.id, parentId: driveItems.parentId, name: driveItems.name, kind: driveItems.kind, size: driveItems.size }).from(driveItems).where(inArray(driveItems.id, allIds)) : [];
    const visible = rows.filter((row) => {
      if (!access.get(row.id) || !searchMetadataEligibility(searchNodes, row.id).eligible) return false;
      if (!folderId || row.id === folderId) return true;
      // A move between listing pages must not import an item outside the requested subtree.
      for (let parent = row.parentId, depth = 0; parent && depth < 64; depth++) {
        if (parent === folderId) return true;
        parent = searchNodes.get(parent)?.parentId ?? null;
      }
      return false;
    });
    const visibleIds = new Set(visible.map((row) => row.id));
    if (folderId && !visibleIds.has(folderId)) throw new DriveError("This folder is no longer available.");
    const nodes: DriveChatTreeNode[] = visible.map((row) => ({ ...row, parentId: row.id !== folderId && row.parentId && visibleIds.has(row.parentId) ? row.parentId : null }));
    if (folderId) title = visible.find((row) => row.id === folderId)!.name;
    return { title, nodes, hasMore: hasMore || visible.length !== ids.size };
  });
}

export function createChatBrowseTools(context: ChatToolContext) {
  const { ctx, cite, run, mentionedOwner, signal } = context;
  return {
    recent_uploads: tool({
      description: "List recent completed file uploads, newest createdAt first (not last modified or recently opened). Filter by inclusive since/exclusive until ISO timestamps and mentioned owner. Continue nextCursor with identical filters; empty pages may still have more candidates.",
      inputSchema: recentChatItemsInput,
      execute: async (input) => run("recent_uploads", "Recent uploads", async () => {
        const owner = mentionedOwner(input.ownerId);
        const page = await discoverChatItems(ctx, { ...input, ownerId: owner?.id, mode: "recent" });
        const items = page.items.map((item) => ({ ...item, citation: cite(item.id, item.name, null, null, item.path) }));
        return {
          result: JSON.stringify({ items, nextCursor: page.nextCursor, note: page.nextCursor !== null ? "Partial page; continue nextCursor before claiming completeness." : "End of results." }),
          update: {
            summary: `${items.length} uploads${page.nextCursor !== null ? " (more available)" : ""}`,
            sourceItemIds: items.map((item) => item.id),
            table: { title: "Recent uploads", columns: ["File", "Uploaded", "Bytes"], rows: items.map((item) => [item.name, item.createdAt, item.size]), truncated: page.nextCursor !== null },
          },
        };
      }),
    }),
    drive_activity: tool({
      description: "List authorized Drive events by event timestamp, newest first; not last modified. since is inclusive and until exclusive. ownerId filters current item owner, not actor. Historical names are replaced with current names and inaccessible references omitted. Protected history is excluded even when unlocked. Continue nextCursor with identical filters.",
      inputSchema: chatActivityInput,
      execute: async (input) => run("drive_activity", "Drive activity", async () => {
        const owner = mentionedOwner(input.ownerId);
        const page = await discoverChatActivity(ctx, { ...input, ownerId: owner?.id });
        const events = page.events.map((event) => ({ ...event, citation: cite(event.item.id, event.item.name, null, null, []), references: event.references.map((ref) => ({ ...ref, citation: cite(ref.id, ref.name, null, null, []) })) }));
        return {
          result: JSON.stringify({ events, nextCursor: page.nextCursor, note: "Names reflect current authorized metadata, not historical snapshots. " + (page.nextCursor !== null ? "More candidates remain; continue nextCursor." : "End of results.") }),
          update: {
            summary: `${events.length} events${page.nextCursor !== null ? " (more available)" : ""}`,
            sourceItemIds: [...new Set(events.flatMap((event) => event.references.map((ref) => ref.id)))],
            table: { title: "Drive activity", columns: ["When", "Action", "Item", "By"], rows: events.map((event) => [event.at, event.action.replaceAll("_", " "), event.item.name, event.actor.name]), truncated: page.nextCursor !== null },
          },
        };
      }),
    }),
    show_drive_tree: tool({
      description: "Render the real authorized folder/file hierarchy, including empty folders, as a collapsible Drive tree. Use actual discovered folderId or omit for root. Bounded by maxDepth/maxNodes and scan work. hasMore means partial: never call it the full structure; narrow to a returned folderId to see more. Never supply model-invented tree nodes.",
      inputSchema: chatTreeInput,
      execute: async (input) => run("show_drive_tree", "Drive structure", async () => {
        const tree = await discoverChatTree(ctx, input, signal);
        return {
          result: JSON.stringify({ ...tree, nodes: tree.nodes.map((node) => ({ ...node, citation: cite(node.id, node.name, null, null, []) })), note: tree.hasMore ? "Partial structure: node, depth or scan bounds reached, or access changed. Narrow to a returned folderId for more." : "Complete authorized structure for this scope." }),
          update: { label: tree.title, ...(input.folderId ? { itemId: input.folderId } : {}), summary: `${tree.nodes.length} items${tree.hasMore ? " (partial structure)" : ""}`, tree },
        };
      }),
    }),
  };
}
