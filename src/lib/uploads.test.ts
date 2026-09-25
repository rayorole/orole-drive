import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { beginUploads } from "@/app/actions/uploads";
import { EMAIL_DOMAIN_WHITELIST } from "./auth-policy";
import { session, user } from "./auth-schema";
import type { Database } from "./db";
import { runWithDriveContext, withDriveTransaction } from "./drive-access";
import { driveEvents, driveFileVersions, driveFolderUnlocks, driveItems, driveUploadWork } from "./drive-schema";
import { DriveError } from "./drive-errors";
import { cleanupUpload, cleanupVersion, queueVersionCleanup } from "./storage";
import { cancelPendingUpload, ensureUploadFolders, finishUpload, startUpload } from "./uploads";

// Real SQL concurrency, opt-in only; the storage boundary is isolated and never contacts R2.
test("upload publication and cleanup preserve identity across concurrent changes", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const url = process.env.TEST_DATABASE_URL!;
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "Upload race tests require local PostgreSQL.");
  const client = postgres(url, { max: 5, connection: { lock_timeout: 2000 } });
  const claimClient = postgres(url, { max: 3 });
  const db = drizzle(client);
  const globals = globalThis as typeof globalThis & { oroleDatabase?: Database; oroleStorageClaims?: postgres.Sql };
  const previousDb = globals.oroleDatabase;
  const previousClaims = globals.oroleStorageClaims;
  const envKeys = ["DATABASE_URL", "R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.DATABASE_URL = url;
  process.env.R2_ENDPOINT = "https://upload-tests.r2.cloudflarestorage.com";
  process.env.R2_BUCKET = "isolated-upload-tests";
  process.env.R2_ACCESS_KEY_ID = "test";
  process.env.R2_SECRET_ACCESS_KEY = "test";
  globals.oroleDatabase = db;
  globals.oroleStorageClaims = claimClient;
  const ownerId = randomUUID();
  const userId = randomUUID();
  const rootId = randomUUID();
  const passwordVersion = randomUUID();
  const ctx = { userId, sessionId: randomUUID(), email: `${userId}@${EMAIL_DOMAIN_WHITELIST[0]}` };
  type Stored = { ContentLength: number; ContentType: string; Metadata: { "upload-id": string }; ETag: string };
  const objects = new Map<string, Stored>();
  const uploadIds: string[] = [];
  let beforeCopy: (() => Promise<void>) | undefined;
  let beforeStagedHead: (() => Promise<void>) | undefined;
  t.mock.method(S3Client.prototype, "send", async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const key = String(command.input.Key);
    switch (command.constructor.name) {
      case "HeadObjectCommand": {
        if (key.startsWith("uploads/")) await beforeStagedHead?.();
        const found = objects.get(key);
        if (!found) throw Object.assign(new Error("Missing"), { name: "NotFound" });
        return found;
      }
      case "CopyObjectCommand": {
        await beforeCopy?.();
        const source = objects.get(String(command.input.CopySource).split("/").slice(1).join("/"));
        assert.ok(source, "Copy source must survive until publication commits");
        assert.equal(command.input.CopySourceIfMatch, source.ETag);
        objects.set(key, { ...source });
        return {};
      }
      case "DeleteObjectCommand": objects.delete(key); return {};
      case "AbortMultipartUploadCommand": return {};
      case "ListMultipartUploadsCommand": return { Uploads: [], IsTruncated: false };
      default: throw new Error(`Unexpected storage operation: ${command.constructor.name}`);
    }
  });
  const stage = async (name: string, resolution?: "replace") => {
    const ticket = await startUpload(ctx, { key: randomUUID(), name, parentId: rootId, size: 4, mimeType: "text/plain", resolution });
    uploadIds.push(ticket.id);
    const [row] = await db.select().from(driveItems).where(eq(driveItems.id, ticket.id));
    objects.set(`uploads/${row.objectKey!.slice("files/".length)}`, { ContentLength: 4, ContentType: "text/plain", Metadata: { "upload-id": row.id }, ETag: `\"${randomUUID()}\"` });
    return row;
  };
  const pauseCopy = () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    beforeCopy = async () => { reached.resolve(); await release.promise; };
    return { reached: reached.promise, release: () => { beforeCopy = undefined; release.resolve(); } };
  };
  try {
    await db.insert(user).values([
      { id: ownerId, name: "Upload owner", email: `${ownerId}@${EMAIL_DOMAIN_WHITELIST[0]}`, emailVerified: true },
      { id: userId, name: "Upload editor", email: ctx.email, emailVerified: true },
    ]);
    await db.insert(session).values({ id: ctx.sessionId, token: randomUUID(), userId, expiresAt: new Date(Date.now() + 600_000) });
    await db.insert(driveItems).values({ id: rootId, name: "Upload race fixture", kind: "folder", state: "complete", ownerId,
      accessMode: "members", memberRole: "editor", passwordHash: "fixture-password", passwordVersion });
    await db.insert(driveFolderUnlocks).values({ sessionId: ctx.sessionId, folderId: rootId, passwordVersion, expiresAt: new Date(Date.now() + 600_000) });

    await t.test("ACL revocation proceeds during R2 work and blocks publication", async () => {
      const row = await stage("revoked.txt");
      const gate = pauseCopy();
      const finishing = finishUpload(ctx, row.id);
      const rejected = assert.rejects(finishing, DriveError);
      await gate.reached;
      try {
        await withDriveTransaction("write", async (tx) => {
          await tx.execute(sql`set local lock_timeout = '1s'`);
          await tx.update(driveItems).set({ memberRole: "viewer" }).where(eq(driveItems.id, rootId));
        });
      } finally { gate.release(); }
      await rejected;
      const [pending] = await db.select().from(driveItems).where(eq(driveItems.id, row.id));
      assert.equal(pending.state, "pending");
      assert.equal((await db.select().from(driveEvents).where(eq(driveEvents.itemId, row.id))).length, 0);
      await db.update(driveItems).set({ memberRole: "editor" }).where(eq(driveItems.id, rootId));
      await cancelPendingUpload(ctx, row.id);
    });

    await t.test("cancellation fences an in-flight completion and cleanup removes only its bytes", async () => {
      const row = await stage("cancelled.txt");
      const gate = pauseCopy();
      const rejected = assert.rejects(finishUpload(ctx, row.id));
      await gate.reached;
      try { await cancelPendingUpload(ctx, row.id); } finally { gate.release(); }
      await rejected;
      await cleanupUpload(row.id);
      assert.equal((await db.select().from(driveItems).where(eq(driveItems.id, row.id))).length, 0);
      assert.equal(objects.has(row.objectKey!), false);
      const [work] = await db.select().from(driveUploadWork).where(eq(driveUploadWork.id, row.id));
      assert.equal(work.status, "cancelled");
    });

    await t.test("replacement completion is retryable and retired-version cleanup cannot mark the current file deleting", async () => {
      const original = await stage("versioned.txt");
      await finishUpload(ctx, original.id);
      const replacing = await stage("versioned.txt", "replace");
      assert.equal((await finishUpload(ctx, replacing.id)).id, original.id);
      assert.equal((await finishUpload(ctx, replacing.id)).id, original.id);
      const versions = await db.select().from(driveFileVersions).where(eq(driveFileVersions.itemId, original.id));
      assert.equal(versions.length, 1);
      const [published] = await db.select().from(driveItems).where(eq(driveItems.id, original.id));
      await cleanupUpload(replacing.id);
      assert.equal(objects.has(published.objectKey!), true);
      await withDriveTransaction("write", async (tx) => {
        await queueVersionCleanup(tx, versions[0]);
        await tx.delete(driveFileVersions).where(eq(driveFileVersions.id, versions[0].id));
      });
      await cleanupVersion(versions[0]);
      const [live] = await db.select().from(driveItems).where(eq(driveItems.id, original.id));
      assert.equal(live.deletionStartedAt, null);
      assert.equal(live.objectKey, published.objectKey);
      assert.equal(objects.has(live.objectKey!), true);
      assert.equal(objects.has(versions[0].objectKey), false);
    });

    await t.test("an overlapping legacy finalizer cannot have its published bytes overwritten", async () => {
      const row = await stage("legacy-overlap.txt");
      const stagedKey = `uploads/${row.objectKey!.slice("files/".length)}`;
      const original = objects.get(stagedKey)!;
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      beforeStagedHead = async () => { beforeStagedHead = undefined; reached.resolve(); await release.promise; };
      const finishing = finishUpload(ctx, row.id).catch((error: unknown) => error);
      await reached.promise;
      try {
        await withDriveTransaction("write", async (tx) => {
          objects.set(row.objectKey!, { ...original });
          await tx.update(driveItems).set({ state: "complete", etag: original.ETag }).where(eq(driveItems.id, row.id));
        });
        // Legacy completion removes staging; a still-valid PUT can recreate it.
        objects.delete(stagedKey);
        objects.set(stagedKey, { ...original, ETag: `"${randomUUID()}"` });
      } finally { release.resolve(); }
      await finishing;
      const [live] = await db.select().from(driveItems).where(eq(driveItems.id, row.id));
      assert.equal(live.objectKey, row.objectKey);
      assert.equal(live.etag, original.ETag);
      assert.equal(objects.get(live.objectKey!)?.ETag, original.ETag);
      assert.equal((await finishUpload(ctx, row.id)).id, row.id);
      await cleanupUpload(row.id);
      assert.equal(objects.get(live.objectKey!)?.ETag, original.ETag);
      const [work] = await db.select().from(driveUploadWork).where(eq(driveUploadWork.id, row.id));
      if (work.publicationKey) assert.equal(objects.has(work.publicationKey), false);
    });

    await t.test("invalid file metadata does not reject other reservations in its batch", async () => {
      const validKey = randomUUID();
      const invalidKey = randomUUID();
      const batch = await runWithDriveContext({ context: ctx, capabilities: new Set(["write"]) }, () => beginUploads([
        { key: validKey, name: "batch-valid.txt", parentId: rootId, size: 4, mimeType: "text/plain" },
        { key: invalidKey, name: "", parentId: rootId, size: 4, mimeType: "text/plain" },
      ]));
      assert.equal(batch.success, true);
      const valid = batch.data.find((entry) => entry.key === validKey)!.result;
      const invalid = batch.data.find((entry) => entry.key === invalidKey)!.result;
      assert.equal(valid.success, true);
      assert.equal(invalid.success, false);
      uploadIds.push(valid.data.id);
      const [reserved] = await db.select().from(driveItems).where(eq(driveItems.id, valid.data.id));
      assert.equal(reserved.name, "batch-valid.txt");
      assert.equal(reserved.state, "pending");
      await cancelPendingUpload(ctx, valid.data.id);
    });

    await t.test("batched folder dependencies reject read-only destinations and roll back partial ancestors", async () => {
      const [readonly] = await db.insert(driveItems).values({ id: randomUUID(), name: "Read only", parentId: rootId, kind: "folder", state: "complete", ownerId, accessMode: "members", memberRole: "viewer" }).returning();
      await assert.rejects(ensureUploadFolders(ctx, [
        { key: "new", name: "Rolled back", parentId: rootId },
        { key: "denied", name: "Cannot write here", parentId: readonly.id },
      ]));
      assert.equal((await db.select().from(driveItems).where(and(eq(driveItems.parentId, rootId), eq(driveItems.name, "Rolled back")))).length, 0);
      const result = await ensureUploadFolders(ctx, [
        { key: "parent", name: "Parent", parentId: rootId },
        { key: "child", name: "Child", parentId: null, parentKey: "parent" },
      ]);
      assert.equal(result[1].folder.parentId, result[0].folder.id);
      assert.equal((await db.select().from(driveEvents).where(inArray(driveEvents.itemId, result.map((entry) => entry.folder.id)))).length, 2);
    });
  } finally {
    beforeCopy = undefined;
    beforeStagedHead = undefined;
    try {
      await db.execute(sql`delete from drive_items where parent_id in (select id from drive_items where parent_id = ${rootId}::uuid)`);
      await db.delete(driveItems).where(eq(driveItems.parentId, rootId));
      await db.delete(driveItems).where(eq(driveItems.id, rootId));
      if (uploadIds.length) await db.delete(driveUploadWork).where(inArray(driveUploadWork.id, uploadIds));
      await db.delete(driveEvents).where(eq(driveEvents.actorId, userId));
      await db.delete(user).where(inArray(user.id, [userId, ownerId]));
    } finally {
      globals.oroleDatabase = previousDb;
      globals.oroleStorageClaims = previousClaims;
      for (const key of envKeys) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
      await Promise.all([client.end(), claimClient.end()]);
    }
  }
});
