import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Database } from "./db";
import { driveItems } from "./drive-schema";
import { commitDecision, searchEligibility, type SearchNode } from "./search-eligibility";
import { enqueueSearch, flushSearchOrphans, indexItem, removeFromSearch, runSearchSweep, type SearchExtractor } from "./search-index";
import { driveSearchChunks, driveSearchDocs, driveSearchOrphans } from "./search-schema";

const node = (id: string, parentId: string | null, values: Partial<SearchNode> = {}): SearchNode => ({
  id, parentId, kind: parentId === null || id.startsWith("folder") ? "folder" : "file", state: "complete",
  trashed: false, deleting: false, hasPassword: false, searchExcluded: false, ...values,
});
const tree = (...nodes: SearchNode[]) => new Map(nodes.map((entry) => [entry.id, entry]));

test("eligibility: protected, trashed and excluded ancestors all keep a file out", () => {
  const file = node("file", "folder-b", { kind: "file" });
  assert.deepEqual(searchEligibility(tree(node("root", null), node("folder-b", "root"), file), "file"), { eligible: true });
  assert.deepEqual(searchEligibility(tree(node("root", null, { hasPassword: true }), node("folder-b", "root"), file), "file"), { eligible: false, reason: "protected" });
  assert.deepEqual(searchEligibility(tree(node("root", null, { searchExcluded: true }), node("folder-b", "root"), file), "file"), { eligible: false, reason: "excluded" });
  assert.deepEqual(searchEligibility(tree(node("root", null, { trashed: true }), node("folder-b", "root"), file), "file"), { eligible: false, reason: "trashed" });
  assert.deepEqual(searchEligibility(tree(node("root", null, { deleting: true }), node("folder-b", "root"), file), "file"), { eligible: false, reason: "trashed" });
  // Protection wins over exclusion, so Details explains the stronger rule.
  assert.deepEqual(searchEligibility(tree(node("root", null, { searchExcluded: true }), node("folder-b", "root", { hasPassword: true }), file), "file"), { eligible: false, reason: "protected" });
  assert.deepEqual(searchEligibility(tree(node("folder-b", "missing"), file), "file"), { eligible: false, reason: "trashed" });
  assert.deepEqual(searchEligibility(tree(node("root", null), { ...file, parentId: "root", state: "pending" }), "file"), { eligible: false, reason: "unsupported" });
  const cycle = tree(node("folder-a", "folder-c"), node("folder-c", "folder-a"), { ...file, parentId: "folder-a" });
  assert.deepEqual(searchEligibility(cycle, "file"), { eligible: false, reason: "trashed" });
});

test("commit decision: a stale etag or lost lease never overwrites current chunks", () => {
  const eligible = { eligible: true } as const;
  assert.equal(commitDecision({ leaseHeld: true, extractedEtag: "a", currentEtag: "a", eligibility: eligible }), "commit");
  assert.equal(commitDecision({ leaseHeld: true, extractedEtag: "a", currentEtag: "b", eligibility: eligible }), "stale");
  assert.equal(commitDecision({ leaseHeld: true, extractedEtag: "a", currentEtag: undefined, eligibility: eligible }), "stale");
  assert.equal(commitDecision({ leaseHeld: false, extractedEtag: "a", currentEtag: "a", eligibility: eligible }), "lost");
  assert.deepEqual(commitDecision({ leaseHeld: true, extractedEtag: "a", currentEtag: "a", eligibility: { eligible: false, reason: "protected" } }), { skip: "protected" });
});

// This opt-in suite never falls back to the application's DATABASE_URL.
test("indexing commits current, eligible contents only", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 4 });
  const db = drizzle(client);
  const databaseGlobal = globalThis as typeof globalThis & { oroleDatabase?: Database };
  const previous = { db: databaseGlobal.oroleDatabase, fetch: globalThis.fetch, account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_AI_API_TOKEN };
  databaseGlobal.oroleDatabase = db;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account";
  process.env.CLOUDFLARE_AI_API_TOKEN = "token";
  const calls: { path: string; body: string }[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    const body = String(init.body);
    calls.push({ path, body });
    if (path.includes("/ai/run/")) {
      const texts: string[] = JSON.parse(body).text;
      return Response.json({ success: true, result: { data: texts.map(() => Array.from({ length: 1024 }, () => 0.01)) } });
    }
    return Response.json({ success: true, result: { mutationId: "m" } });
  }) as typeof fetch;
  const folderId = randomUUID();
  const fileId = randomUUID();
  const etag = () => `"${randomUUID()}"`;
  const extractor = (text: string, during?: () => Promise<unknown>): SearchExtractor => async () => {
    await during?.();
    return { sections: [{ text, location: null }] };
  };
  const chunks = () => db.select().from(driveSearchChunks).where(eq(driveSearchChunks.itemId, fileId)).orderBy(driveSearchChunks.ordinal);
  const doc = async () => (await db.select().from(driveSearchDocs).where(eq(driveSearchDocs.itemId, fileId)))[0];
  const journaled: string[] = [];
  try {
    await db.insert(driveItems).values({ id: folderId, name: "Belastingen", kind: "folder", state: "complete" });
    await db.insert(driveItems).values({ id: fileId, name: "aangifte.txt", kind: "file", state: "complete", parentId: folderId, accessMode: "inherit", size: 10, mimeType: "text/plain", objectKey: `files/${fileId}/a`, etag: etag() });

    await t.test("a queued file is extracted, chunked, embedded and marked indexed", async () => {
      await enqueueSearch(db, [fileId, folderId]);
      assert.equal(await indexItem(fileId, extractor("Aangifte inkomstenbelasting 2025")), "indexed");
      const stored = await chunks();
      assert.deepEqual(stored.map((chunk) => chunk.text), ["aangifte.txt\n\nAangifte inkomstenbelasting 2025"]);
      const current = await doc();
      assert.equal(current.status, "indexed");
      assert.equal(current.contentHash, (await db.select().from(driveItems).where(eq(driveItems.id, fileId)))[0].etag);
      const upsert = calls.find((call) => call.path.endsWith("/upsert"));
      assert.equal(JSON.parse(upsert!.body).id, stored[0].id, "the chunk id is the vector id");
      assert.equal((await db.select().from(driveSearchDocs).where(eq(driveSearchDocs.itemId, folderId))).length, 0, "folders are never queued");
      assert.equal(await indexItem(fileId, extractor("again")), "busy", "an indexed doc is not claimable");
    });

    await t.test("contents replaced during extraction are discarded and re-queued", async () => {
      const before = await chunks();
      await enqueueSearch(db, [fileId]);
      const outcome = await indexItem(fileId, extractor("Oude tekst", () => db.update(driveItems).set({ etag: etag() }).where(eq(driveItems.id, fileId))));
      assert.equal(outcome, "requeued");
      assert.deepEqual((await chunks()).map((chunk) => chunk.id), before.map((chunk) => chunk.id), "stale text never replaces current chunks");
      assert.equal((await doc()).status, "queued");
      assert.equal(await indexItem(fileId, extractor("Nieuwe tekst")), "indexed");
      assert.match((await chunks())[0].text, /Nieuwe tekst/);
      assert.ok((await db.select().from(driveSearchOrphans).where(inArray(driveSearchOrphans.vectorId, before.map((chunk) => chunk.id)))).length === 0, "replaced vectors were deleted");
      assert.ok(calls.some((call) => call.path.endsWith("/delete_by_ids") && before.every((chunk) => call.body.includes(chunk.id))));
    });

    await t.test("a password added while extracting keeps the file out of search", async () => {
      await enqueueSearch(db, [fileId]);
      const outcome = await indexItem(fileId, extractor("Geheim", async () => {
        await db.update(driveItems).set({ passwordHash: "fixture", passwordVersion: randomUUID() }).where(eq(driveItems.id, folderId));
      }));
      assert.equal(outcome, "skipped");
      assert.deepEqual(await chunks(), []);
      assert.deepEqual({ status: (await doc()).status, reason: (await doc()).skipReason }, { status: "skipped", reason: "protected" });
      await enqueueSearch(db, [fileId]);
      assert.equal(await indexItem(fileId, extractor("Geheim")), "skipped", "a protected folder stays out even when queued");
      await db.update(driveItems).set({ passwordHash: null, passwordVersion: null }).where(eq(driveItems.id, folderId));
    });

    await t.test("removal is synchronous in Postgres and journals vectors for Vectorize", async () => {
      await enqueueSearch(db, [fileId]);
      assert.equal(await indexItem(fileId, extractor("Te verwijderen")), "indexed");
      const ids = (await chunks()).map((chunk) => chunk.id);
      journaled.push(...ids);
      await removeFromSearch(db, [folderId], "excluded");
      assert.deepEqual(await chunks(), []);
      assert.equal((await doc()).skipReason, "excluded");
      assert.equal((await db.select().from(driveSearchOrphans).where(inArray(driveSearchOrphans.vectorId, ids))).length, ids.length);
      globalThis.fetch = (async () => new Response("", { status: 503, headers: { "retry-after": "0" } })) as typeof fetch;
      await assert.rejects(flushSearchOrphans(Date.now() + 10_000));
      assert.equal((await db.select().from(driveSearchOrphans).where(inArray(driveSearchOrphans.vectorId, ids))).length, ids.length, "a failed delete stays journaled for the sweeper");
    });

    await t.test("failures back off and stop after five attempts", async () => {
      await db.update(driveItems).set({ searchExcluded: false }).where(eq(driveItems.id, folderId));
      await enqueueSearch(db, [fileId]);
      assert.equal(await indexItem(fileId, async () => { throw new Error("secret file text"); }), "failed");
      const failed = await doc();
      assert.deepEqual({ status: failed.status, attempts: failed.attempts }, { status: "failed", attempts: 1 });
      assert.doesNotMatch(failed.error ?? "", /secret/);
      assert.equal(await indexItem(fileId, extractor("x")), "busy", "a fresh failure waits before its retry");
      await db.update(driveSearchDocs).set({ attempts: 5, queuedAt: sql`now() - interval '1 day'` }).where(eq(driveSearchDocs.itemId, fileId));
      assert.equal(await indexItem(fileId, extractor("x")), "busy", "gives up after five attempts");
    });

    await t.test("the sweep reports configured work without search credentials as a no-op", async () => {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      assert.deepEqual(await runSearchSweep({ budgetMs: 1_000 }), { configured: false, indexed: 0, skipped: 0, failed: 0, requeued: 0, backfilled: 0, orphansDeleted: 0 });
      process.env.CLOUDFLARE_ACCOUNT_ID = "account";
    });
  } finally {
    databaseGlobal.oroleDatabase = previous.db;
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [["CLOUDFLARE_ACCOUNT_ID", previous.account], ["CLOUDFLARE_AI_API_TOKEN", previous.token]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      if (journaled.length) await db.delete(driveSearchOrphans).where(inArray(driveSearchOrphans.vectorId, journaled));
      await db.delete(driveItems).where(eq(driveItems.id, fileId));
      await db.delete(driveItems).where(eq(driveItems.id, folderId));
    } finally {
      await client.end();
    }
  }
});
