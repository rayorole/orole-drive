import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { EMAIL_DOMAIN_WHITELIST } from "./auth-policy";
import { authThrottle, session, user } from "./auth-schema";
import type { Database } from "./db";
import type { DriveContext } from "./drive-access";
import { driveFolderUnlocks, driveItems } from "./drive-schema";
import { semanticSearch } from "./search-query";
import { driveSearchChunks } from "./search-schema";

// This opt-in suite never falls back to the application's DATABASE_URL.
test("semantic search re-authorizes every hit for the searching member", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 4 });
  const db = drizzle(client);
  const databaseGlobal = globalThis as typeof globalThis & { oroleDatabase?: Database };
  const previous = { db: databaseGlobal.oroleDatabase, fetch: globalThis.fetch, account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_AI_API_TOKEN };
  databaseGlobal.oroleDatabase = db;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account";
  process.env.CLOUDFLARE_AI_API_TOKEN = "token";
  const memberId = randomUUID();
  const otherId = randomUUID();
  const ctx: DriveContext = { sessionId: randomUUID(), userId: memberId, email: `${memberId}@${EMAIL_DOMAIN_WHITELIST[0]}` };
  const ids = { folder: randomUUID(), readable: randomUUID(), foreign: randomUUID(), vault: randomUUID(), secret: randomUUID(), excluded: randomUUID(), hidden: randomUUID() };
  const chunkIds: string[] = [];
  let vectorHits: string[] = [];
  let cloudflareDown = false;
  globalThis.fetch = (async (url: string | URL) => {
    if (cloudflareDown) return new Response("", { status: 400 });
    const path = new URL(String(url)).pathname;
    if (path.includes("/ai/run/")) return Response.json({ success: true, result: { data: [Array.from({ length: 1024 }, () => 0.5)] } });
    return Response.json({ success: true, result: { count: vectorHits.length, matches: vectorHits.map((id, index) => ({ id, score: 1 - index / 100 })) } });
  }) as typeof fetch;
  const file = (id: string, name: string, parentId: string | null, ownerId: string) => ({ id, name, kind: "file" as const, state: "complete" as const, parentId, ownerId, accessMode: parentId ? "inherit" as const : "private" as const, size: 10, mimeType: "text/plain", objectKey: `files/${id}/x`, etag: "\"e\"" });
  async function chunk(itemId: string, text: string) {
    const id = randomUUID();
    chunkIds.push(id);
    await db.insert(driveSearchChunks).values({ id, itemId, ordinal: 0, location: null, text });
    return id;
  }
  const search = async (query: string, options: { folderId?: string } = {}) => {
    await db.delete(authThrottle).where(eq(authThrottle.key, `semantic-search:${memberId}`));
    return semanticSearch(ctx, { query, ...options });
  };
  try {
    await db.insert(user).values([
      { id: memberId, name: "Searcher", email: ctx.email, emailVerified: true },
      { id: otherId, name: "Other", email: `${otherId}@${EMAIL_DOMAIN_WHITELIST[0]}`, emailVerified: true },
    ]);
    await db.insert(session).values({ id: ctx.sessionId, token: randomUUID(), userId: memberId, expiresAt: new Date(Date.now() + 600_000) });
    const versionId = randomUUID();
    await db.insert(driveItems).values([
      { id: ids.folder, name: "Reizen", kind: "folder", state: "complete", ownerId: memberId, accessMode: "private" },
      { id: ids.vault, name: "Kluis", kind: "folder", state: "complete", ownerId: memberId, accessMode: "private", passwordHash: "fixture", passwordVersion: versionId },
      { id: ids.hidden, name: "Privé", kind: "folder", state: "complete", ownerId: memberId, accessMode: "private", searchExcluded: true },
    ]);
    await db.insert(driveItems).values([
      file(ids.readable, "texel.txt", ids.folder, memberId),
      file(ids.foreign, "texel-van-een-ander.txt", null, otherId),
      file(ids.secret, "texel-geheim.txt", ids.vault, memberId),
      file(ids.excluded, "texel-privé.txt", ids.hidden, memberId),
    ]);
    // The member has unlocked the vault in this session; its contents must still never be returned.
    await db.insert(driveFolderUnlocks).values({ sessionId: ctx.sessionId, folderId: ids.vault, passwordVersion: versionId, expiresAt: new Date(Date.now() + 600_000) });
    const readable = await chunk(ids.readable, "texel.txt\n\nVakantie op Texel in de zomer met de fiets.");
    const foreign = await chunk(ids.foreign, "Vakantie op Texel, een ander zijn plannen.");
    const secret = await chunk(ids.secret, "Vakantie op Texel: de code van de kluis.");
    const excluded = await chunk(ids.excluded, "Vakantie op Texel, privé notities.");

    await t.test("hits the member can't read, protected hits and excluded hits are dropped", async () => {
      vectorHits = [foreign, secret, excluded, readable];
      const result = await search("vakantie texel");
      assert.equal(result.degraded, false);
      assert.deepEqual(result.results.map((hit) => hit.item.id), [ids.readable]);
      const [hit] = result.results;
      assert.deepEqual(hit.path, ["Reizen"]);
      assert.equal(hit.folderId, ids.folder);
      assert.deepEqual(hit.passages, [{ text: "Vakantie op Texel in de zomer met de fiets.", location: null }], "the name prefix is not repeated in the passage");
      assert.ok(!JSON.stringify(result).includes("kluis") && !JSON.stringify(result).includes("ander"));
    });

    await t.test("semantic-only hits are found and fused with keyword hits", async () => {
      vectorHits = [readable];
      assert.deepEqual((await search("zonnige eilanden")).results.map((hit) => hit.item.id), [ids.readable]);
    });

    await t.test("a folder filter keeps only its subtree and needs access to the folder", async () => {
      vectorHits = [readable];
      assert.equal((await search("texel", { folderId: ids.folder })).results.length, 1);
      assert.equal((await search("texel", { folderId: ids.hidden })).results.length, 0);
      await assert.rejects(search("texel", { folderId: randomUUID() }), /no longer available/);
    });

    await t.test("when Cloudflare fails, keyword results still come back marked degraded", async () => {
      cloudflareDown = true;
      const result = await search("fiets");
      assert.equal(result.degraded, true);
      assert.deepEqual(result.results.map((hit) => hit.item.id), [ids.readable]);
      cloudflareDown = false;
    });

    await t.test("trashing drops a hit at once", async () => {
      vectorHits = [readable];
      await db.update(driveItems).set({ trashedAt: new Date() }).where(eq(driveItems.id, ids.folder));
      assert.equal((await search("texel")).results.length, 0);
      await db.update(driveItems).set({ trashedAt: null }).where(eq(driveItems.id, ids.folder));
    });

    await t.test("searches are rate limited per member", async () => {
      await db.delete(authThrottle).where(eq(authThrottle.key, `semantic-search:${memberId}`));
      for (let index = 0; index < 20; index++) await semanticSearch(ctx, { query: "texel" });
      await assert.rejects(semanticSearch(ctx, { query: "texel" }), /Too many searches/);
      await assert.rejects(search("x".repeat(501)), /up to 500 characters/);
    });
  } finally {
    databaseGlobal.oroleDatabase = previous.db;
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [["CLOUDFLARE_ACCOUNT_ID", previous.account], ["CLOUDFLARE_AI_API_TOKEN", previous.token]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await db.delete(authThrottle).where(eq(authThrottle.key, `semantic-search:${memberId}`));
      await db.delete(driveItems).where(inArray(driveItems.id, [ids.readable, ids.foreign, ids.secret, ids.excluded]));
      await db.delete(driveItems).where(inArray(driveItems.id, [ids.folder, ids.vault, ids.hidden]));
      await db.delete(user).where(inArray(user.id, [memberId, otherId]));
    } finally {
      await client.end();
    }
  }
});
