import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { embed, vectorQuery } from "@/lib/cloudflare-ai";
import { getDb } from "@/lib/db";
import { tryItemsAccess, visibleItemsCondition, withDriveTransaction } from "@/lib/drive-access";
import type { DriveContext } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { idSchema } from "@/lib/drive-input";
import { driveItems } from "@/lib/drive-schema";
import type { SemanticSearchHit, SemanticSearchInput, SemanticSearchResult } from "@/lib/drive-types";
import { itemType } from "@/lib/item-type";
import { isSearchConfigured } from "@/lib/search-config";
import { searchEligibility } from "@/lib/search-eligibility";
import type { SearchNode } from "@/lib/search-eligibility";
import { loadSearchNodes } from "@/lib/search-index";
import { fuseRankings, passageSnippet, queryTerms } from "@/lib/search-rank";
import { driveSearchChunks } from "@/lib/search-schema";
import { toDriveItem } from "@/lib/storage";
import { consumeThrottle } from "@/lib/throttle";

export const SEMANTIC_QUERY_MAX_CHARS = 500;
const CANDIDATES = 50;
const PASSAGES_PER_ITEM = 3;
export const SEARCHES_PER_MINUTE = 20;

export const semanticSearchInput = z.object({
  query: z.string().trim().min(1, "Enter something to search for.").max(SEMANTIC_QUERY_MAX_CHARS, `Search for up to ${SEMANTIC_QUERY_MAX_CHARS} characters at a time.`),
  limit: z.number().int().min(1).max(25).default(10),
  folderId: idSchema.nullable().optional(),
  type: z.enum(["all", "folder", "image", "video", "audio", "pdf", "text", "code", "archive", "other"]).optional(),
});

function insideFolder(nodes: ReadonlyMap<string, SearchNode>, id: string, folderId: string): boolean {
  const seen = new Set<string>();
  for (let cursor = nodes.get(id)?.parentId ?? null; cursor && !seen.has(cursor); cursor = nodes.get(cursor)?.parentId ?? null) {
    if (cursor === folderId) return true;
    seen.add(cursor);
  }
  return false;
}

/**
 * Hybrid search over file contents: Vectorize neighbours of the query embedding fused with Postgres
 * full-text matches. Cloudflare knows nothing about permissions, so every candidate is re-authorized
 * here for this actor, right now: unreadable, protected (even unlocked), excluded, trashed or
 * unfinished items are dropped without a trace. When Cloudflare fails, keyword results still return.
 */
export async function semanticSearch(ctx: DriveContext, input: SemanticSearchInput): Promise<SemanticSearchResult> {
  const { query, limit, folderId, type } = semanticSearchInput.parse(input);
  if (!isSearchConfigured()) throw new DriveError("AI search is not set up for this drive.");
  if (!await consumeThrottle(getDb(), `semantic-search:${ctx.userId}`, SEARCHES_PER_MINUTE, 60)) {
    throw new DriveError("Too many searches in a short time. Wait a minute and try again.");
  }
  const signal = AbortSignal.timeout(10_000);
  const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;
  const [semantic, keyword] = await Promise.all([
    embed([query], signal).then(([vector]) => vectorQuery(vector, CANDIDATES, signal)).then((matches) => matches.map((match) => match.id)).catch(() => null),
    // Narrowed to visible items so other members' matches cannot crowd out this member's; authorization happens below.
    withDriveTransaction("read", (tx) => tx.execute<{ id: string }>(sql`
      select chunk.id from ${driveSearchChunks} chunk join ${driveItems} on ${driveItems.id} = chunk.item_id
      where chunk.tsv @@ ${tsQuery} and ${visibleItemsCondition(ctx)}
      order by ts_rank_cd(chunk.tsv, ${tsQuery}) desc limit ${CANDIDATES}
    `)),
  ]);
  const fused = fuseRankings([semantic ?? [], keyword.map((row) => row.id)]);
  const results = fused.size ? await withDriveTransaction("read", async (tx): Promise<SemanticSearchHit[]> => {
    if (folderId && !(await tryItemsAccess(tx, ctx, [folderId], { permission: "read" })).get(folderId)) throw new DriveError("This folder is no longer available.");
    const rows = await tx.select({ chunk: driveSearchChunks, item: driveItems }).from(driveSearchChunks)
      .innerJoin(driveItems, eq(driveItems.id, driveSearchChunks.itemId))
      .where(and(
        inArray(driveSearchChunks.id, [...fused.keys()]),
        eq(driveItems.kind, "file"), eq(driveItems.state, "complete"), isNull(driveItems.trashedAt), isNull(driveItems.deletionStartedAt),
        type && type !== "all" ? sql`${itemType} = ${type}` : undefined,
      ));
    const itemIds = [...new Set(rows.map((row) => row.item.id))];
    const nodes = await loadSearchNodes(tx, itemIds);
    const candidates = itemIds.filter((id) => searchEligibility(nodes, id).eligible && (!folderId || insideFolder(nodes, id, folderId)));
    const access = await tryItemsAccess(tx, ctx, candidates, { permission: "read" });
    const allowed = new Set(candidates.filter((id) => access.get(id)));
    // Path names come only from ancestors this actor can read, stopping at the first one it cannot.
    const ancestorIds = new Set<string>();
    for (const id of allowed) for (let cursor = nodes.get(id)?.parentId ?? null; cursor && !ancestorIds.has(cursor); cursor = nodes.get(cursor)?.parentId ?? null) ancestorIds.add(cursor);
    const ancestorAccess = await tryItemsAccess(tx, ctx, [...ancestorIds], { permission: "read" });
    const readable = [...ancestorIds].filter((id) => ancestorAccess.get(id));
    const names = new Map(readable.length ? (await tx.select({ id: driveItems.id, name: driveItems.name }).from(driveItems).where(inArray(driveItems.id, readable))).map((row) => [row.id, row.name]) : []);
    const terms = queryTerms(query);
    const byItem = new Map<string, typeof rows>();
    for (const row of rows) if (allowed.has(row.item.id)) byItem.set(row.item.id, [...byItem.get(row.item.id) ?? [], row]);
    return [...byItem.values()].map((matches) => {
      matches.sort((a, b) => fused.get(b.chunk.id)! - fused.get(a.chunk.id)!);
      const item = matches[0].item;
      const flags = access.get(item.id)!;
      const path: string[] = [];
      for (let cursor = item.parentId; cursor && names.has(cursor) && path.length < 64; cursor = nodes.get(cursor)?.parentId ?? null) path.unshift(names.get(cursor)!);
      return {
        item: { ...toDriveItem(item), ...flags },
        folderId: flags.parentId,
        path,
        score: fused.get(matches[0].chunk.id)!,
        passages: matches.slice(0, PASSAGES_PER_ITEM).map(({ chunk }) => {
          // The first passage leads with the file name for name-only matches; the name is shown separately.
          const text = chunk.ordinal === 0 && chunk.text.startsWith(`${item.name}\n\n`) ? chunk.text.slice(item.name.length + 2) : chunk.text;
          return { text: passageSnippet(text, terms), location: chunk.location };
        }),
      };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
  }) : [];
  return { results, degraded: semantic === null };
}
