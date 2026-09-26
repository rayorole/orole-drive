import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { EMAIL_DOMAIN_WHITELIST, FamilyAuthError } from "./auth-policy";
import { session, user } from "./auth-schema";
import { readableCitedItems } from "./chat";
import { discoverChatItems } from "./chat-discovery";
import type { Database } from "./db";
import type { DriveContext } from "./drive-access";
import { driveFolderUnlocks, driveItems } from "./drive-schema";
import { searchEligibility, searchMetadataEligibility, type SearchNode } from "./search-eligibility";

test("folder metadata eligibility preserves AI exclusions without indexing folders", () => {
  const root: SearchNode = { id: "root", parentId: null, kind: "folder", state: "complete", trashed: false, deleting: false, hasPassword: false, searchExcluded: false };
  const child: SearchNode = { ...root, id: "child", parentId: root.id };
  const nodes = new Map([[root.id, root], [child.id, child]]);
  assert.deepEqual(searchMetadataEligibility(nodes, child.id), { eligible: true });
  assert.deepEqual(searchEligibility(nodes, child.id), { eligible: false, reason: "unsupported" });
  for (const [property, reason] of [["hasPassword", "protected"], ["searchExcluded", "excluded"], ["trashed", "trashed"], ["deleting", "trashed"]] as const) {
    nodes.set(root.id, { ...root, [property]: true });
    assert.deepEqual(searchMetadataEligibility(nodes, child.id), { eligible: false, reason });
  }
  nodes.set(root.id, { ...root, state: "pending" });
  assert.deepEqual(searchMetadataEligibility(nodes, child.id), { eligible: false, reason: "unsupported" });
  nodes.set(root.id, { ...root, kind: "file" });
  assert.deepEqual(searchMetadataEligibility(nodes, child.id), { eligible: false, reason: "unsupported" });
  nodes.set(root.id, { ...root, parentId: child.id });
  assert.deepEqual(searchMetadataEligibility(nodes, child.id), { eligible: false, reason: "trashed" });
  nodes.delete(root.id);
  assert.deepEqual(searchMetadataEligibility(nodes, child.id), { eligible: false, reason: "trashed" });
});

// Explicitly opt in; never run fixtures against the application's DATABASE_URL.
test("Ask AI discovers folder and filename metadata with fresh authorization", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 2 });
  const db = drizzle(client);
  const databaseGlobal = globalThis as typeof globalThis & { oroleDatabase?: Database };
  const previous = databaseGlobal.oroleDatabase;
  databaseGlobal.oroleDatabase = db;
  const memberId = randomUUID();
  const otherId = randomUUID();
  const ctx: DriveContext = { sessionId: randomUUID(), userId: memberId, email: `${memberId}@${EMAIL_DOMAIN_WHITELIST[0]}` };
  const ids = { coding: randomUUID(), nested: randomUUID(), empty: randomUUID(), foreign: randomUUID(), vault: randomUUID(), excluded: randomUUID(), trashed: randomUUID(), pending: randomUUID(), file: randomUUID(), nestedFile: randomUUID(), secret: randomUUID(), excludedFile: randomUUID(), trashedFile: randomUUID(), foreignFile: randomUUID(), shared: randomUUID(), literal: randomUUID() };
  const roots = [ids.coding, ids.empty, ids.foreign, ids.vault, ids.excluded, ids.trashed, ids.pending];
  const children = [ids.file, ids.nestedFile, ids.secret, ids.excludedFile, ids.trashedFile, ids.foreignFile, ids.shared, ids.literal];
  const passwordVersion = randomUUID();
  try {
    await db.insert(user).values([memberId, otherId].map((id) => ({ id, name: id, email: `${id}@${EMAIL_DOMAIN_WHITELIST[0]}`, emailVerified: true })));
    await db.insert(session).values({ id: ctx.sessionId, token: randomUUID(), userId: memberId, expiresAt: new Date(Date.now() + 600_000) });
    await db.insert(driveItems).values([
      { id: ids.coding, name: "Coding", kind: "folder", state: "complete", ownerId: memberId, accessMode: "private" },
      { id: ids.empty, name: "Empty", kind: "folder", state: "complete", ownerId: memberId, accessMode: "private" },
      { id: ids.foreign, name: "Foreign private", kind: "folder", state: "complete", ownerId: otherId, accessMode: "private" },
      { id: ids.vault, name: "A protected", kind: "folder", state: "complete", ownerId: memberId, accessMode: "private", passwordHash: "fixture", passwordVersion },
      { id: ids.excluded, name: "B excluded", kind: "folder", state: "complete", ownerId: memberId, accessMode: "private", searchExcluded: true },
      { id: ids.trashed, name: "Trashed", kind: "folder", state: "complete", ownerId: memberId, accessMode: "private", trashedAt: new Date() },
      { id: ids.pending, name: "Pending", kind: "file", state: "pending", ownerId: memberId, accessMode: "private", size: 10, mimeType: "text/plain", objectKey: `files/${ids.pending}/x` },
    ]);
    await db.insert(driveItems).values({ id: ids.nested, name: "Coding experiments", kind: "folder", state: "complete", parentId: ids.coding, ownerId: memberId, accessMode: "inherit" });
    await db.insert(driveItems).values([
      { id: ids.file, name: "project-plan.txt", parentId: ids.coding, ownerId: memberId },
      { id: ids.nestedFile, name: "nested.pdf", parentId: ids.nested, ownerId: memberId },
      { id: ids.secret, name: "protected.txt", parentId: ids.vault, ownerId: memberId },
      { id: ids.excludedFile, name: "excluded.txt", parentId: ids.excluded, ownerId: memberId },
      { id: ids.trashedFile, name: "trashed.txt", parentId: ids.trashed, ownerId: memberId },
      { id: ids.foreignFile, name: "foreign.txt", parentId: ids.foreign, ownerId: otherId },
      { id: ids.shared, name: "shared.txt", parentId: ids.foreign, ownerId: otherId, accessMode: "members" as const, memberRole: "viewer" as const },
      { id: ids.literal, name: "100%_done.txt", parentId: ids.coding, ownerId: memberId },
    ].map((row) => ({ kind: "file" as const, state: "complete" as const, accessMode: "inherit" as const, size: 10, mimeType: "text/plain", objectKey: `files/${row.id}/x`, etag: '"e"', ...row })));
    await db.insert(driveFolderUnlocks).values({ sessionId: ctx.sessionId, folderId: ids.vault, passwordVersion, expiresAt: new Date(Date.now() + 600_000) });

    await t.test("all folders includes nested and empty folders, never hidden ones", async () => {
      const found = await discoverChatItems(ctx, { mode: "find", kind: "folder", ownerId: memberId });
      assert.deepEqual(found.items.map((item) => item.id), [ids.coding, ids.nested, ids.empty]);
      assert.deepEqual(found.items[1].path, ["Coding"]);
      assert.equal(found.nextCursor, null);
    });
    await t.test("name discovery is case-insensitive and folder contents are direct, not recursive", async () => {
      const found = await discoverChatItems(ctx, { mode: "find", query: "cOdInG", kind: "folder", ownerId: memberId });
      assert.deepEqual(found.items.map((item) => item.id), [ids.coding, ids.nested]);
      const listed = await discoverChatItems(ctx, { mode: "list", folderId: ids.coding, kind: "file" });
      assert.deepEqual(listed.items.map((item) => item.id), [ids.literal, ids.file]);
      assert.deepEqual(listed.folder, { id: ids.coding, name: "Coding" });
      assert.deepEqual((await discoverChatItems(ctx, { mode: "list", folderId: ids.empty })).items, []);
    });
    await t.test("unindexed filenames match literal wildcard characters", async () => {
      assert.deepEqual((await discoverChatItems(ctx, { mode: "find", query: "%_", ownerId: memberId })).items.map((item) => item.id), [ids.literal]);
      assert.deepEqual((await discoverChatItems(ctx, { mode: "find", query: "PROJECT-PLAN", ownerId: memberId })).items.map((item) => item.id), [ids.file]);
    });
    await t.test("pagination advances past excluded rows without repeating items", async () => {
      const first = await discoverChatItems(ctx, { mode: "find", kind: "folder", ownerId: memberId, limit: 1 });
      assert.deepEqual(first.items.map((item) => item.id), [ids.coding]);
      assert.notEqual(first.nextCursor, null);
      const second = await discoverChatItems(ctx, { mode: "find", kind: "folder", ownerId: memberId, limit: 1, cursor: first.nextCursor! });
      assert.deepEqual(second.items.map((item) => item.id), [ids.nested]);
      const last = await discoverChatItems(ctx, { mode: "find", kind: "folder", ownerId: memberId, limit: 1, cursor: second.nextCursor! });
      assert.deepEqual(last.items.map((item) => item.id), [ids.empty]);
      assert.equal(last.nextCursor, null);
      await assert.rejects(discoverChatItems(ctx, { mode: "list", limit: 51 }));
      await assert.rejects(discoverChatItems(ctx, { mode: "find", cursor: -1 }));
    });
    await t.test("root discovery preserves direct shares without disclosing private parent metadata", async () => {
      const ownRoot = await discoverChatItems(ctx, { mode: "list", ownerId: memberId });
      assert.deepEqual(ownRoot.items.map((item) => item.id), [ids.coding, ids.empty]);
      const root = await discoverChatItems(ctx, { mode: "list", ownerId: otherId });
      assert.deepEqual(root.items.map((item) => item.id), [ids.shared]);
      const shared = root.items.find((item) => item.id === ids.shared)!;
      assert.deepEqual(shared.path, []);
      assert.equal(shared.parentId, null);
      assert.ok(!JSON.stringify(root).includes("Foreign private"));
      const owned = await discoverChatItems(ctx, { mode: "find", ownerId: otherId });
      assert.deepEqual(owned.items.map((item) => item.id), [ids.shared]);
    });
    await t.test("unavailable folders and file ids cannot be browsed, even with an unlock", async () => {
      for (const folderId of [ids.foreign, ids.vault, ids.excluded, ids.trashed, ids.pending, ids.file, randomUUID()]) {
        await assert.rejects(discoverChatItems(ctx, { mode: "list", folderId }), /no longer available/);
      }
    });
    await t.test("folder citations survive reload only while still eligible", async () => {
      assert.deepEqual([...(await readableCitedItems(ctx, [ids.coding, ids.vault, ids.excluded])).keys()], [ids.coding]);
      await db.update(driveItems).set({ searchExcluded: true }).where(eq(driveItems.id, ids.coding));
      assert.equal((await readableCitedItems(ctx, [ids.coding, ids.file])).size, 0);
      assert.deepEqual((await discoverChatItems(ctx, { mode: "find", query: "coding", ownerId: memberId })).items, []);
      await db.update(driveItems).set({ searchExcluded: false }).where(eq(driveItems.id, ids.coding));
    });
    await t.test("revoked permissions and expired sessions take effect on the next page", async () => {
      await db.update(driveItems).set({ accessMode: "private" }).where(eq(driveItems.id, ids.shared));
      assert.deepEqual((await discoverChatItems(ctx, { mode: "find", ownerId: otherId })).items, []);
      await db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.id, ctx.sessionId));
      await assert.rejects(discoverChatItems(ctx, { mode: "find", kind: "folder" }), FamilyAuthError);
      await assert.rejects(discoverChatItems(ctx, { mode: "list", folderId: ids.coding }), FamilyAuthError);
    });
  } finally {
    databaseGlobal.oroleDatabase = previous;
    try {
      await db.delete(driveItems).where(inArray(driveItems.id, children));
      await db.delete(driveItems).where(eq(driveItems.id, ids.nested));
      await db.delete(driveItems).where(inArray(driveItems.id, roots));
      await db.delete(user).where(inArray(user.id, [memberId, otherId]));
    } finally {
      await client.end();
    }
  }
});
