import "server-only";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { embed, SearchServiceError, vectorDelete, vectorUpsert } from "@/lib/cloudflare-ai";
import { getDb } from "@/lib/db";
import type { Database, DriveTransaction } from "@/lib/db";
import { runAsSystem, withDriveTransaction } from "@/lib/drive-access";
import { driveItems } from "@/lib/drive-schema";
import type { DriveRow } from "@/lib/drive-schema";
import { chunkSections } from "@/lib/search-chunk";
import { isSearchConfigured } from "@/lib/search-config";
import { commitDecision, searchEligibility } from "@/lib/search-eligibility";
import type { SearchNode } from "@/lib/search-eligibility";
import { extractForSearch } from "@/lib/search-extract";
import type { SearchExtraction } from "@/lib/search-extract";
import { driveSearchChunks, driveSearchDocs, driveSearchOrphans } from "@/lib/search-schema";
import type { SearchSkipReason } from "@/lib/search-schema";

type Executor = Database | DriveTransaction;

export const MAX_INDEX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;
/** Inline indexing after a response; the rest waits for the sweeper. */
const AFTER_BUDGET_MS = 60_000;
/** One file can take this long (download, caption, embeddings), so sweeps stop claiming earlier. */
const ITEM_RESERVE_MS = 75_000;
const BACKFILL_BATCH = 200;
const ORPHAN_BATCH = 1_000;

const uuidList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
const subtree = (ids: string[]) => sql`(
  with recursive subtree(id) as (
    select id from drive_items where id in (${uuidList(ids)})
    union
    select child.id from drive_items child join subtree on child.parent_id = subtree.id
  ) select id from subtree
)`;

/** Queued work is claimable; failures back off 10 minutes per attempt; crashed runs lose their lease. */
const claimable = sql`(
  ${driveSearchDocs.status} = 'queued'
  or (${driveSearchDocs.status} = 'failed' and ${driveSearchDocs.attempts} < ${MAX_INDEX_ATTEMPTS}
    and ${driveSearchDocs.queuedAt} < now() - ${driveSearchDocs.attempts} * interval '10 minutes')
  or (${driveSearchDocs.status} = 'indexing' and ${driveSearchDocs.leaseUntil} < now())
)`;

/**
 * Runs once the response is sent, outside any member or MCP actor: indexing is system work and must not
 * fail because the requesting session ended. Outside a request (scripts, tests) the sweeper picks it up.
 */
function afterResponse(work: () => Promise<unknown>) {
  if (!isSearchConfigured()) return;
  try {
    after(() => runAsSystem(work).catch(() => undefined));
  } catch {
    // No request scope.
  }
}

/**
 * Queues files (folders are ignored) for indexing inside the caller's transaction, so a rolled-back
 * change never leaves work behind. Resets attempts: new contents or a new name deserve fresh tries.
 */
export async function enqueueSearch(tx: Executor, itemIds: string[]): Promise<void> {
  if (!itemIds.length) return;
  const rows = await tx.execute<{ id: string }>(sql`
    insert into drive_search_docs (item_id, status, attempts, queued_at)
    select id, 'queued', 0, now() from drive_items
    where id in (${uuidList(itemIds)}) and kind = 'file' and state = 'complete' and trashed_at is null and deletion_started_at is null
    on conflict (item_id) do update set status = 'queued', skip_reason = null, attempts = 0, error = null, queued_at = now(), lease_until = null
    returning item_id as id
  `);
  scheduleIndexing(rows.map((row) => row.id));
}

/**
 * Queues files under these items that search does not currently hold because of where they were:
 * after a restore from Trash, a move out of a protected or excluded folder, or removed protection.
 * Files that are indexed, or skipped for their own contents, are left alone.
 */
export async function enqueueSearchTree(tx: Executor, rootIds: string[]): Promise<void> {
  if (!rootIds.length) return;
  const rows = await tx.execute<{ id: string }>(sql`
    insert into drive_search_docs (item_id, status, attempts, queued_at)
    select item.id, 'queued', 0, now() from drive_items item
    left join drive_search_docs doc on doc.item_id = item.id
    where item.id in ${subtree(rootIds)} and item.kind = 'file' and item.state = 'complete'
      and item.trashed_at is null and item.deletion_started_at is null
      and (doc.item_id is null or doc.status = 'failed' or (doc.status = 'skipped' and doc.skip_reason in ('excluded', 'protected', 'trashed')))
    on conflict (item_id) do update set status = 'queued', skip_reason = null, attempts = 0, error = null, queued_at = now(), lease_until = null
    returning item_id as id
  `);
  scheduleIndexing(rows.map((row) => row.id));
}

/**
 * Removes the passages of these items and everything below them from Postgres right away, inside the
 * caller's transaction, so no later query can return them. Their vectors are journaled and deleted
 * from Vectorize after the response; a failed delete is retried by the sweeper and is harmless meanwhile.
 */
export async function removeFromSearch(tx: Executor, rootIds: string[], reason: SearchSkipReason): Promise<void> {
  if (!rootIds.length) return;
  const removed = await tx.execute<{ id: string }>(sql`
    with removed as (delete from drive_search_chunks where item_id in ${subtree(rootIds)} returning id)
    insert into drive_search_orphans (vector_id) select id from removed on conflict do nothing
    returning vector_id as id
  `);
  await tx.execute(sql`
    update drive_search_docs set status = 'skipped', skip_reason = ${reason}, content_hash = null, error = null, lease_until = null
    where item_id in ${subtree(rootIds)}
  `);
  if (removed.length) afterResponse(() => flushSearchOrphans(Date.now() + 30_000));
}

function scheduleIndexing(itemIds: string[]) {
  if (!itemIds.length) return;
  afterResponse(async () => {
    const deadline = Date.now() + AFTER_BUDGET_MS;
    for (const id of itemIds) {
      if (Date.now() > deadline - ITEM_RESERVE_MS / 2) break;
      await indexItem(id);
    }
  });
}

/** An item and all its ancestors, in one round trip. */
export async function loadSearchNodes(db: Executor, ids: string[]): Promise<Map<string, SearchNode>> {
  if (!ids.length) return new Map();
  const rows = await db.execute<SearchNode & Record<string, unknown>>(sql`
    with recursive ancestors as (
      select item.* from drive_items item where item.id in (${uuidList(ids)})
      union
      select parent.* from drive_items parent join ancestors child on child.parent_id = parent.id
    )
    select id, parent_id as "parentId", kind, state,
      trashed_at is not null as trashed, deletion_started_at is not null as deleting,
      password_hash is not null as "hasPassword", search_excluded as "searchExcluded"
    from ancestors
  `);
  return new Map(rows.map((row) => [row.id, row]));
}

export type IndexOutcome = "indexed" | "skipped" | "requeued" | "failed" | "busy";
export type SearchExtractor = (row: DriveRow, signal: AbortSignal) => Promise<SearchExtraction>;

/**
 * Claims one queued file with a lease and indexes its current contents. The chunk swap commits under
 * the shared hierarchy lock, which every trash, move, password, exclusion and content change takes
 * exclusively: it re-checks eligibility and the etag there, so a file protected, excluded or replaced
 * while it was being extracted never gets stale or forbidden passages.
 */
export async function indexItem(itemId: string, extract: SearchExtractor = extractForSearch): Promise<IndexOutcome> {
  const db = getDb();
  const [claim] = await db.update(driveSearchDocs)
    // Set from the app clock at millisecond precision so the returned value can fence later writes exactly.
    .set({ status: "indexing", leaseUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(driveSearchDocs.itemId, itemId), claimable))
    .returning({ leaseUntil: driveSearchDocs.leaseUntil });
  if (!claim?.leaseUntil) return "busy";
  // The lease timestamp is the fencing token: any re-claim or re-enqueue changes it.
  const lease = and(eq(driveSearchDocs.status, "indexing"), eq(driveSearchDocs.leaseUntil, claim.leaseUntil))!;
  const signal = AbortSignal.timeout(4 * 60_000);
  try {
    const [row] = await db.select().from(driveItems).where(eq(driveItems.id, itemId));
    if (!row) return "busy";
    const before = searchEligibility(await loadSearchNodes(db, [itemId]), itemId);
    if (!before.eligible) {
      await withDriveTransaction("read", (tx) => removeFromSearch(tx, [itemId], before.reason));
      return "skipped";
    }
    const extraction = await extract(row, signal);
    const chunks = "sections" in extraction ? chunkSections(row.name, extraction.sections) : [];
    const skip: SearchSkipReason | null = "skip" in extraction ? extraction.skip : chunks.length ? null : "empty";
    const vectors = skip ? [] : await embed(chunks.map((chunk) => chunk.text), signal);
    const ids = chunks.map(() => randomUUID());
    const decision = await withDriveTransaction("read", async (tx) => {
      const [held] = await tx.select({ itemId: driveSearchDocs.itemId }).from(driveSearchDocs).where(and(eq(driveSearchDocs.itemId, itemId), lease)).for("update");
      const [current] = await tx.select({ etag: driveItems.etag }).from(driveItems).where(eq(driveItems.id, itemId));
      const decision = commitDecision({
        leaseHeld: Boolean(held), extractedEtag: row.etag, currentEtag: current?.etag,
        eligibility: searchEligibility(await loadSearchNodes(tx, [itemId]), itemId),
      });
      if (decision === "lost") return decision;
      if (decision === "stale") {
        await tx.update(driveSearchDocs).set({ status: "queued", leaseUntil: null, queuedAt: new Date() }).where(and(eq(driveSearchDocs.itemId, itemId), lease));
        return decision;
      }
      if (typeof decision === "object" || skip) {
        await removeFromSearch(tx, [itemId], typeof decision === "object" ? decision.skip : skip!);
        return "skipped" as const;
      }
      await tx.execute(sql`
        with removed as (delete from drive_search_chunks where item_id = ${itemId}::uuid returning id)
        insert into drive_search_orphans (vector_id) select id from removed on conflict do nothing
      `);
      for (let index = 0; index < chunks.length; index += 100) {
        await tx.insert(driveSearchChunks).values(chunks.slice(index, index + 100).map((chunk, offset) => ({ id: ids[index + offset], itemId, ...chunk })));
      }
      await tx.update(driveSearchDocs).set({ contentHash: row.etag }).where(and(eq(driveSearchDocs.itemId, itemId), lease));
      return decision;
    });
    if (decision === "lost") return "busy";
    if (decision === "stale") return "requeued";
    if (decision === "skipped") return "skipped";
    await vectorUpsert(ids.map((id, index) => ({ id, values: vectors[index] })), signal);
    await db.update(driveSearchDocs).set({ status: "indexed", indexedAt: new Date(), attempts: 0, error: null, leaseUntil: null, skipReason: null })
      .where(and(eq(driveSearchDocs.itemId, itemId), lease));
    await flushSearchOrphans(Date.now() + 10_000).catch(() => undefined);
    return "indexed";
  } catch (error) {
    // Only status codes and error classes are stored: never text that could echo file contents.
    const message = error instanceof SearchServiceError ? error.message : error instanceof Error ? `${error.name}: indexing failed.` : "Indexing failed.";
    await db.update(driveSearchDocs)
      .set({ status: "failed", attempts: sql`${driveSearchDocs.attempts} + 1`, error: message.slice(0, 200), leaseUntil: null, queuedAt: new Date() })
      .where(and(eq(driveSearchDocs.itemId, itemId), lease)).catch(() => undefined);
    return "failed";
  }
}

/** Deletes journaled vectors from Vectorize in batches until the deadline or a failure. */
export async function flushSearchOrphans(deadline: number): Promise<number> {
  let deleted = 0;
  while (Date.now() < deadline) {
    const batch = await getDb().select({ id: driveSearchOrphans.vectorId }).from(driveSearchOrphans).limit(ORPHAN_BATCH);
    if (!batch.length) break;
    const ids = batch.map((row) => row.id);
    await vectorDelete(ids);
    await getDb().delete(driveSearchOrphans).where(inArray(driveSearchOrphans.vectorId, ids));
    deleted += ids.length;
    if (batch.length < ORPHAN_BATCH) break;
  }
  return deleted;
}

/** Complete, active files search has never seen, and indexed files whose contents changed while search was off. */
async function backfill(): Promise<number> {
  const rows = await getDb().execute<{ id: string }>(sql`
    insert into drive_search_docs (item_id, status, attempts, queued_at)
    select item.id, 'queued', 0, now() from drive_items item
    left join drive_search_docs doc on doc.item_id = item.id
    where item.kind = 'file' and item.state = 'complete' and item.trashed_at is null and item.deletion_started_at is null
      and (doc.item_id is null or (doc.status = 'indexed' and doc.content_hash is distinct from item.etag))
    order by item.updated_at desc
    limit ${BACKFILL_BATCH}
    on conflict (item_id) do update set status = 'queued', attempts = 0, error = null, queued_at = now(), lease_until = null
    returning item_id as id
  `);
  return rows.length;
}

export type SearchSweepResult = { configured: boolean; indexed: number; skipped: number; failed: number; requeued: number; backfilled: number; orphansDeleted: number };

/** Retries failures, finishes queued work, deletes orphaned vectors and backfills older files, within the budget. */
export async function runSearchSweep({ budgetMs }: { budgetMs: number }): Promise<SearchSweepResult> {
  const result: SearchSweepResult = { configured: isSearchConfigured(), indexed: 0, skipped: 0, failed: 0, requeued: 0, backfilled: 0, orphansDeleted: 0 };
  if (!result.configured) return result;
  const deadline = Date.now() + budgetMs;
  result.orphansDeleted = await flushSearchOrphans(deadline - ITEM_RESERVE_MS).catch(() => 0);
  const attempted = new Set<string>();
  while (Date.now() < deadline - ITEM_RESERVE_MS) {
    const next = await getDb().select({ id: driveSearchDocs.itemId }).from(driveSearchDocs).where(claimable).orderBy(driveSearchDocs.queuedAt).limit(20);
    const fresh = next.filter((row) => !attempted.has(row.id));
    if (!fresh.length) {
      const added = await backfill();
      result.backfilled += added;
      if (!added) break;
      continue;
    }
    for (const { id } of fresh) {
      if (Date.now() >= deadline - ITEM_RESERVE_MS) break;
      attempted.add(id);
      const outcome = await indexItem(id);
      if (outcome !== "busy") result[outcome] += 1;
    }
  }
  return result;
}
