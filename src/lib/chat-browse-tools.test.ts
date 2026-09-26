import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { activityReferenceIds, chatActivityDetails } from "./activity";
import { EMAIL_DOMAIN_WHITELIST, FamilyAuthError } from "./auth-policy";
import { session, user } from "./auth-schema";
import { chatActivityInput, chatTreeInput, discoverChatActivity, discoverChatTree } from "./chat-browse-tools";
import { discoverChatItems, recentChatItemsInput } from "./chat-discovery";
import type { Database } from "./db";
import type { DriveContext } from "./drive-access";
import { driveEvents, driveFolderUnlocks, driveItems } from "./drive-schema";

const since = "2026-09-25T00:00:00Z";
const until = "2026-09-26T00:00:00Z";

test("browse date windows require real timezone-qualified instants and increasing bounds", () => {
  for (const schema of [recentChatItemsInput, chatActivityInput]) {
    assert.equal(schema.safeParse({ since, until }).success, true);
    assert.equal(schema.safeParse({ since: "2026-09-25T02:00:00+02:00", until }).success, true);
    for (const input of [{ since: "2026-02-30T00:00:00Z" }, { since: "2026-09-25" }, { until: "2026-09-25T12:00:00" }, { since, until: since }, { since: until, until: since }, { limit: 0 }, { limit: 51 }]) {
      assert.equal(schema.safeParse(input).success, false, JSON.stringify(input));
    }
  }
  assert.equal(recentChatItemsInput.safeParse({ cursor: -1 }).success, false);
  assert.equal(chatActivityInput.safeParse({ cursor: "not-an-event-id" }).success, false);
  for (const input of [{ maxDepth: 0 }, { maxDepth: 13 }, { maxNodes: 0 }, { maxNodes: 201 }]) assert.equal(chatTreeInput.safeParse(input).success, false);
});

test("historical details never trust orphaned names, malformed links or arbitrary text", () => {
  const itemId = randomUUID();
  const parentId = randomUUID();
  const sourceId = randomUUID();
  const event = { itemId, parentId, details: { fromParentId: "invalid", fromParentName: "private old folder", toParentName: "stale folder", sourceId, fromName: "historical secret", renamedFrom: "another secret", unknown: "private payload", size: 12, bytes: -1, count: Number.NaN, publicRevoked: true } };
  assert.deepEqual(activityReferenceIds(event), [itemId, parentId, sourceId]);
  assert.deepEqual(chatActivityDetails(event, () => undefined), { size: 12, publicRevoked: true });
  assert.deepEqual(chatActivityDetails(event, (id) => id === parentId ? { id, name: "Current folder" } : id === sourceId ? { id, name: "Source" } : undefined), { size: 12, publicRevoked: true, toParentName: "Current folder", sourceId });
});

// Explicit opt-in; fixture writes never use the application's DATABASE_URL.
test("AI browse date filters, bounded hierarchy and historical authorization", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 2 });
  const db = drizzle(client);
  const globalDatabase = globalThis as typeof globalThis & { oroleDatabase?: Database };
  const previous = globalDatabase.oroleDatabase;
  globalDatabase.oroleDatabase = db;
  const memberId = randomUUID();
  const otherId = randomUUID();
  const ctx: DriveContext = { sessionId: randomUUID(), userId: memberId, email: `${memberId}@${EMAIL_DOMAIN_WHITELIST[0]}` };
  const ids = { root: randomUUID(), empty: randomUUID(), nested: randomUUID(), excluded: randomUUID(), vault: randomUUID(), private: randomUUID(), start: randomUUID(), middle: randomUUID(), end: randomUUID(), old: randomUUID(), hidden: randomUUID(), secret: randomUUID(), shared: randomUUID(), pending: randomUUID(), trash: randomUUID(), deleting: randomUUID() };
  const childIds = [ids.empty, ids.nested, ids.start, ids.middle, ids.end, ids.old, ids.hidden, ids.secret, ids.shared, ids.pending, ids.trash, ids.deleting];
  const rootIds = [ids.root, ids.excluded, ids.vault, ids.private];
  const passwordVersion = randomUUID();
  const eventIds = { start: randomUUID(), middle: randomUUID(), end: randomUUID(), old: randomUUID(), moved: randomUUID(), historicalProtected: randomUUID(), shared: randomUUID(), hidden: randomUUID(), secret: randomUUID(), missing: randomUUID() };
  const file = (id: string, parentId: string, createdAt = new Date(since)) => ({ id, parentId, name: `file-${id}.txt`, kind: "file" as const, state: "complete" as const, ownerId: memberId, accessMode: "inherit" as const, size: 10, mimeType: "text/plain", objectKey: `files/${id}/x`, etag: '"fixture"', createdAt, updatedAt: new Date("2026-09-30T00:00:00Z") });
  try {
    await db.insert(user).values([memberId, otherId].map((id) => ({ id, name: id, email: `${id}@${EMAIL_DOMAIN_WHITELIST[0]}`, emailVerified: true })));
    await db.insert(session).values({ id: ctx.sessionId, token: randomUUID(), userId: memberId, expiresAt: new Date(Date.now() + 600_000) });
    await db.insert(driveItems).values([
      { id: ids.root, name: "Browse root", kind: "folder", state: "complete", ownerId: memberId },
      { id: ids.excluded, name: "Excluded historical folder", kind: "folder", state: "complete", ownerId: memberId, searchExcluded: true },
      { id: ids.vault, name: "Protected", kind: "folder", state: "complete", ownerId: memberId, passwordHash: "fixture", passwordVersion },
      { id: ids.private, name: "Private other", kind: "folder", state: "complete", ownerId: otherId },
    ]);
    await db.insert(driveItems).values([
      { id: ids.empty, parentId: ids.root, name: "Empty", kind: "folder", state: "complete", ownerId: memberId, accessMode: "inherit" },
      { id: ids.nested, parentId: ids.root, name: "Nested", kind: "folder", state: "complete", ownerId: memberId, accessMode: "inherit" },
      file(ids.start, ids.root),
      file(ids.middle, ids.nested, new Date("2026-09-25T12:00:00Z")),
      file(ids.end, ids.root, new Date(until)),
      file(ids.old, ids.root, new Date("2026-09-24T23:59:59.999Z")),
      file(ids.hidden, ids.excluded), file(ids.secret, ids.vault),
      { ...file(ids.shared, ids.private), ownerId: otherId, accessMode: "members", memberRole: "viewer" },
      { ...file(ids.pending, ids.root), state: "pending", etag: null },
      { ...file(ids.trash, ids.root), trashedAt: new Date() },
      { ...file(ids.deleting, ids.root), deletionStartedAt: new Date(), trashedAt: new Date() },
    ]);
    await db.insert(driveFolderUnlocks).values({ sessionId: ctx.sessionId, folderId: ids.vault, passwordVersion, expiresAt: new Date(Date.now() + 600_000) });
    await db.insert(driveEvents).values([
      { id: eventIds.start, itemId: ids.start, at: new Date(since), action: "upload" as const },
      { id: eventIds.middle, itemId: ids.middle, at: new Date("2026-09-25T12:00:00Z"), action: "upload" as const },
      { id: eventIds.end, itemId: ids.end, at: new Date(until), action: "upload" as const },
      { id: eventIds.old, itemId: ids.old, at: new Date("2026-09-24T23:59:59.999Z"), action: "upload" as const },
      { id: eventIds.moved, itemId: ids.start, at: new Date("2026-09-25T13:00:00Z"), action: "move" as const, parentId: ids.excluded, details: { fromParentId: ids.private, fromParentName: "Private snapshot", toParentName: "Excluded snapshot", sourceId: ids.secret, renamedFrom: "Secret old name" } },
      { id: eventIds.historicalProtected, itemId: ids.start, at: new Date("2026-09-25T14:00:00Z"), action: "rename" as const, protected: true },
      { id: eventIds.shared, itemId: ids.shared, at: new Date(since), action: "upload" as const },
      { id: eventIds.hidden, itemId: ids.hidden, at: new Date(since), action: "upload" as const },
      { id: eventIds.secret, itemId: ids.secret, at: new Date(since), action: "upload" as const },
      { id: eventIds.missing, itemId: randomUUID(), at: new Date(since), action: "delete" as const },
    ].map((event) => ({ actorId: otherId, actorEmail: `${otherId}@${EMAIL_DOMAIN_WHITELIST[0]}`, itemName: "Historical snapshot not current name", itemKind: "file" as const, ...event })));

    await t.test("uploads use createdAt, half-open instants, current owner and pagination", async () => {
      const first = await discoverChatItems(ctx, { mode: "recent", since: "2026-09-25T02:00:00+02:00", until, ownerId: memberId, limit: 1 });
      assert.deepEqual(first.items.map((item) => item.id), [ids.middle]);
      assert.equal(first.items[0].createdAt, "2026-09-25T12:00:00.000Z");
      assert.notEqual(first.nextCursor, null);
      const second = await discoverChatItems(ctx, { mode: "recent", since, until, ownerId: memberId, limit: 1, cursor: first.nextCursor! });
      assert.deepEqual(second.items.map((item) => item.id), [ids.start]);
      const ownedByOther = await discoverChatItems(ctx, { mode: "recent", since, until, ownerId: otherId });
      assert.deepEqual(ownedByOther.items.map((item) => item.id), [ids.shared]);
      assert.equal(ownedByOther.items[0].parentId, null);
      assert.deepEqual(ownedByOther.items[0].path, []);
    });
    await t.test("activity filters event time rather than file time and sanitizes historical references", async () => {
      const page = await discoverChatActivity(ctx, { since, until, ownerId: memberId });
      assert.deepEqual(page.events.map((event) => event.id), [eventIds.moved, eventIds.middle, eventIds.start]);
      const moved = page.events[0];
      assert.equal(moved.item.name, `file-${ids.start}.txt`);
      assert.equal(moved.parent, null);
      assert.deepEqual(moved.details, {});
      assert.deepEqual(moved.references.map((ref) => ref.id), [ids.start]);
      assert.equal(JSON.stringify(page).includes("snapshot"), false);
      assert.deepEqual((await discoverChatActivity(ctx, { since, until, ownerId: otherId })).events.map((event) => event.id), [eventIds.shared]);
      for (const folderId of [ids.vault, ids.excluded, ids.private, ids.start]) await assert.rejects(discoverChatActivity(ctx, { folderId }), /no longer available/);
    });
    await t.test("activity keyset pagination does not duplicate when a new event arrives", async () => {
      const first = await discoverChatActivity(ctx, { since, until, ownerId: memberId, limit: 1 });
      const laterId = randomUUID();
      await db.insert(driveEvents).values({ id: laterId, at: new Date("2026-09-25T15:00:00Z"), actorId: memberId, actorEmail: ctx.email, action: "rename", itemId: ids.start, itemName: "new event", itemKind: "file" });
      const second = await discoverChatActivity(ctx, { since, until, ownerId: memberId, limit: 1, cursor: first.nextCursor! });
      assert.deepEqual(second.events.map((event) => event.id), [eventIds.middle]);
      const third = await discoverChatActivity(ctx, { since, until, ownerId: memberId, limit: 1, cursor: second.nextCursor! });
      assert.deepEqual(third.events.map((event) => event.id), [eventIds.start]);
      // Remaining raw candidates can all be excluded; their cursor must still terminate.
      if (third.nextCursor) {
        const last = await discoverChatActivity(ctx, { since, until, ownerId: memberId, limit: 1, cursor: third.nextCursor });
        assert.deepEqual(last.events, []);
        assert.equal(last.nextCursor, null);
      }
    });
    await t.test("real trees contain empty folders and correct nested parent IDs, with explicit bounds", async () => {
      const tree = await discoverChatTree(ctx, { folderId: ids.root });
      assert.equal(tree.hasMore, false);
      assert.deepEqual(new Set(tree.nodes.map((node) => node.id)), new Set([ids.root, ids.empty, ids.nested, ids.start, ids.middle, ids.end, ids.old]));
      assert.equal(tree.nodes.find((node) => node.id === ids.middle)?.parentId, ids.nested);
      assert.equal(tree.nodes.find((node) => node.id === ids.root)?.parentId, null);
      const empty = await discoverChatTree(ctx, { folderId: ids.empty, maxNodes: 1 });
      assert.deepEqual(empty.nodes.map((node) => node.id), [ids.empty]);
      assert.equal(empty.hasMore, false);
      const bounded = await discoverChatTree(ctx, { folderId: ids.root, maxNodes: 1 });
      assert.deepEqual(bounded.nodes.map((node) => node.id), [ids.root]);
      assert.equal(bounded.hasMore, true);
      const shallow = await discoverChatTree(ctx, { folderId: ids.root, maxDepth: 1 });
      assert.equal(shallow.nodes.some((node) => node.id === ids.middle), false);
      assert.equal(shallow.hasMore, true);
      for (const folderId of [ids.vault, ids.excluded, ids.private]) await assert.rejects(discoverChatTree(ctx, { folderId }), /no longer available/);
    });
    await t.test("bounded history scans advance through excluded rows without disclosing them", async () => {
      await db.insert(driveEvents).values(Array.from({ length: 501 }, (_, index) => ({ at: new Date(Date.parse("2026-09-25T20:00:00Z") + index), actorId: memberId, actorEmail: ctx.email, action: "rename" as const, itemId: ids.hidden, itemName: "Excluded log", itemKind: "file" as const })));
      const first = await discoverChatActivity(ctx, { since, until, ownerId: memberId });
      assert.deepEqual(first.events, []);
      assert.notEqual(first.nextCursor, null);
      const next = await discoverChatActivity(ctx, { since, until, ownerId: memberId, cursor: first.nextCursor! });
      assert.deepEqual(next.events.map((event) => event.item.id), [ids.start, ids.start, ids.middle, ids.start]);
      assert.equal(next.nextCursor, null);
    });
    await t.test("revocation, exclusion and session expiry affect subsequent calls", async () => {
      await db.update(driveItems).set({ accessMode: "private" }).where(eq(driveItems.id, ids.shared));
      assert.deepEqual((await discoverChatActivity(ctx, { ownerId: otherId })).events, []);
      assert.deepEqual((await discoverChatItems(ctx, { mode: "recent", ownerId: otherId })).items, []);
      await db.update(driveItems).set({ searchExcluded: true }).where(eq(driveItems.id, ids.root));
      await assert.rejects(discoverChatActivity(ctx, { itemId: ids.start }), /no longer available/);
      await assert.rejects(discoverChatTree(ctx, { folderId: ids.root }), /no longer available/);
      assert.deepEqual((await discoverChatItems(ctx, { mode: "recent", ownerId: memberId })).items, []);
      await db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.id, ctx.sessionId));
      await assert.rejects(discoverChatActivity(ctx, {}), FamilyAuthError);
      await assert.rejects(discoverChatTree(ctx, {}), FamilyAuthError);
      await assert.rejects(discoverChatItems(ctx, { mode: "recent" }), FamilyAuthError);
    });
  } finally {
    globalDatabase.oroleDatabase = previous;
    try {
      await db.delete(driveEvents).where(inArray(driveEvents.actorId, [memberId, otherId]));
      await db.delete(driveItems).where(inArray(driveItems.id, [ids.start, ids.middle, ids.end, ids.old, ids.hidden, ids.secret, ids.shared, ids.pending, ids.trash, ids.deleting]));
      await db.delete(driveItems).where(inArray(driveItems.id, childIds));
      await db.delete(driveItems).where(inArray(driveItems.id, rootIds));
      await db.delete(user).where(inArray(user.id, [memberId, otherId]));
    } finally {
      await client.end();
    }
  }
});
