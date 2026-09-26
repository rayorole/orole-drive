import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { workAsyncStorage, type WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage, type WorkUnitStore } from "next/dist/server/app-render/work-unit-async-storage.external";
import postgres from "postgres";
import { approveChatAction } from "@/app/actions/chat-mutations";
import { completeUpload } from "@/app/actions/drive";
import { EMAIL_DOMAIN_WHITELIST } from "./auth-policy";
import { session, user } from "./auth-schema";
import { approvedAttachmentBytes, prepareChatMutation, recoverExpiredChatApprovals } from "./chat-mutations";
import { driveChatMessages, driveChats } from "./chat-schema";
import type { Database } from "./db";
import { runWithDriveContext, withDriveTransaction, type DriveContext } from "./drive-access";
import { driveEvents, driveFolderUnlocks, driveItems, driveUploadWork } from "./drive-schema";
import type { DriveChatApproval, DriveChatMutationRequest, DriveChatStep } from "./drive-types";
import { driveSearchDocs } from "./search-schema";

const original = Buffer.from("exact original attachment\n");
const attachment: Extract<DriveChatMutationRequest, { operation: "save_attachment" }> = {
  operation: "save_attachment", attachmentId: randomUUID(), name: "original.txt", parentId: null,
  mimeType: "text/plain", size: original.length, sha256: createHash("sha256").update(original).digest("hex"),
};

test("approved attachment bytes reject changed, missing and malformed browser payloads", () => {
  assert.deepEqual(approvedAttachmentBytes(attachment, original.toString("base64")), original);
  const changed = Buffer.from(original);
  changed[0] ^= 1;
  for (const data of [undefined, "", changed.toString("base64"), original.subarray(1).toString("base64"), `${original.toString("base64")}!`, `data:text/plain;base64,${original.toString("base64")}`]) {
    assert.throws(() => approvedAttachmentBytes(attachment, data));
  }
});

// Real PostgreSQL claim/ACL/hierarchy semantics, isolated storage transport; never targets application data.
test("chat approvals bind persisted previews and safely run real Drive mutation paths", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const url = process.env.TEST_DATABASE_URL!;
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
  const client = postgres(url, { max: 5, connection: { lock_timeout: 3000 } });
  const claims = postgres(url, { max: 3 });
  const db = drizzle(client);
  const globals = globalThis as typeof globalThis & { oroleDatabase?: Database; oroleStorageClaims?: postgres.Sql };
  const previousDb = globals.oroleDatabase;
  const previousClaims = globals.oroleStorageClaims;
  const envKeys = ["DATABASE_URL", "R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.DATABASE_URL = url;
  process.env.R2_ENDPOINT = "https://chat-mutation-tests.r2.cloudflarestorage.com";
  process.env.R2_BUCKET = "isolated-chat-mutations";
  process.env.R2_ACCESS_KEY_ID = "test";
  process.env.R2_SECRET_ACCESS_KEY = "test";
  globals.oroleDatabase = db;
  globals.oroleStorageClaims = claims;
  const ctx: DriveContext = { userId: randomUUID(), sessionId: randomUUID(), email: "" };
  const other: DriveContext = { userId: randomUUID(), sessionId: randomUUID(), email: "" };
  for (const member of [ctx, other]) member.email = `${member.userId}@${EMAIL_DOMAIN_WHITELIST[0]}`;
  const chatId = randomUUID();
  const otherChatId = randomUUID();
  const rootId = randomUUID();
  const destinationId = randomUUID();
  const sharedDestinationId = randomUUID();
  const background: unknown[] = [];
  let failAfterResponse = false;
  const workStore = { afterContext: { after: (task: unknown) => { if (failAfterResponse) throw new Error("Simulated response hook failure"); background.push(task); } } } as unknown as WorkStore;
  const requestStore = { type: "request", phase: "action" } as WorkUnitStore;
  const run = <T>(actor: DriveContext, work: () => Promise<T>) => workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, () => runWithDriveContext({ context: actor, capabilities: new Set(["read", "write", "trash"]) }, work)));
  const independentRequest = new AsyncResource("ordinary-upload-request");
  type Stored = { ContentLength: number; ContentType: string; Metadata: { "upload-id": string }; ETag: string; bytes: Buffer };
  const objects = new Map<string, Stored>();
  const putBytes: Buffer[] = [];
  const uploadIds = new Set<string>();
  let beforePut: (() => Promise<void>) | undefined;
  let afterPut: ((uploadId: string) => Promise<void>) | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(input));
    assert.equal(target.hostname, "chat-mutation-tests.r2.cloudflarestorage.com");
    assert.ok(init);
    assert.equal(init?.method, "PUT");
    const bytes = Buffer.from(init.body as Buffer);
    const headers = new Headers(init.headers);
    uploadIds.add(headers.get("x-amz-meta-upload-id")!);
    const key = decodeURIComponent(target.pathname).replace(/^\/isolated-chat-mutations\//, "");
    assert.equal(headers.get("if-none-match"), "*");
    assert.equal(objects.has(key), false);
    await beforePut?.();
    objects.set(key, { ContentLength: bytes.length, ContentType: headers.get("content-type")!, Metadata: { "upload-id": headers.get("x-amz-meta-upload-id")! }, ETag: `"${createHash("sha256").update(bytes).digest("hex")}"`, bytes });
    putBytes.push(bytes);
    await afterPut?.(headers.get("x-amz-meta-upload-id")!);
    return new Response(null, { status: 200 });
  });
  t.mock.method(S3Client.prototype, "send", async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const key = String(command.input.Key);
    switch (command.constructor.name) {
      case "HeadObjectCommand": {
        const found = objects.get(key);
        if (!found) throw Object.assign(new Error("Missing"), { name: "NotFound" });
        return found;
      }
      case "CopyObjectCommand": {
        const source = objects.get(String(command.input.CopySource).split("/").slice(1).join("/"));
        assert.ok(source);
        assert.equal(command.input.CopySourceIfMatch, source.ETag);
        objects.set(key, { ...source });
        return {};
      }
      case "DeleteObjectCommand": objects.delete(key); return {};
      case "ListMultipartUploadsCommand": return { Uploads: [], IsTruncated: false };
      case "AbortMultipartUploadCommand": return {};
      default: throw new Error(`Unexpected storage operation: ${command.constructor.name}`);
    }
  });
  const save = async (request: DriveChatMutationRequest, overrides: Partial<DriveChatApproval> = {}, ownerChatId = chatId, contentSourceIds: string[] = []) => {
    const { approval } = await prepareChatMutation(ctx, request, contentSourceIds);
    const messageId = randomUUID();
    const stepId = randomUUID();
    const step: DriveChatStep = { id: stepId, tool: request.operation, status: "done", label: approval.title, approval: { ...approval, ...overrides } };
    await db.insert(driveChatMessages).values({ id: messageId, chatId: ownerChatId, role: "assistant", content: "Review before approval.", steps: [step] });
    return { messageId, stepId, decision: "approve" as const };
  };
  const storedApproval = async (messageId: string) => {
    const [message] = await db.select().from(driveChatMessages).where(eq(driveChatMessages.id, messageId));
    return message.steps[0].approval!;
  };
  const approved = async (input: Parameters<typeof approveChatAction>[0]) => {
    const result = await run(ctx, () => approveChatAction(input));
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  };
  try {
    await db.insert(user).values([ctx, other].map((member) => ({ id: member.userId, name: "Approval fixture", email: member.email, emailVerified: true })));
    await db.insert(session).values([ctx, other].map((member) => ({ id: member.sessionId, token: randomUUID(), userId: member.userId, expiresAt: new Date(Date.now() + 600_000) })));
    await db.insert(driveChats).values([{ id: chatId, userId: ctx.userId, title: "Approvals" }, { id: otherChatId, userId: other.userId, title: "Other chat" }]);
    await db.insert(driveItems).values([rootId, destinationId].map((id) => ({ id, name: id === rootId ? "Source" : "Destination", kind: "folder" as const, state: "complete" as const, ownerId: ctx.userId, accessMode: "private" as const })));
    await db.insert(driveItems).values({ id: sharedDestinationId, name: "Shared destination", kind: "folder", state: "complete", ownerId: other.userId, accessMode: "members", memberRole: "editor" });

    await t.test("preview writes nothing; browser destinations are rejected and foreign members cannot claim", async () => {
      const preview = await save({ operation: "create_folder", name: "Approved folder", parentId: rootId });
      assert.deepEqual(await db.select({ id: driveItems.id }).from(driveItems).where(eq(driveItems.parentId, rootId)), []);
      const tampered = { ...preview, parentId: destinationId, name: "Tampered name" };
      assert.equal((await run(ctx, () => approveChatAction(tampered))).success, false);
      assert.equal((await run(other, () => approveChatAction(preview))).success, false);
      assert.equal((await storedApproval(preview.messageId)).status, "pending");
      const result = await approved(preview);
      assert.equal(result.status, "completed");
      const [created] = await db.select().from(driveItems).where(eq(driveItems.id, result.result!.itemIds[0]));
      assert.equal(created.name, "Approved folder");
      assert.equal(created.parentId, rootId);
      assert.equal(created.ownerId, ctx.userId);
      assert.equal((await run(ctx, () => approveChatAction(preview))).success, false);
    });
    await t.test("atomic claim permits only one concurrent approval and cannot mix message/step identities", async () => {
      const preview = await save({ operation: "create_folder", name: "Concurrent", parentId: rootId });
      const foreign = await save({ operation: "create_folder", name: "Foreign", parentId: rootId }, {}, otherChatId);
      assert.equal((await run(ctx, () => approveChatAction({ ...foreign, stepId: preview.stepId }))).success, false);
      const results = await Promise.all([run(ctx, () => approveChatAction(preview)), run(ctx, () => approveChatAction(preview))]);
      assert.equal(results.filter((result) => result.success).length, 1);
      assert.equal((await storedApproval(preview.messageId)).status, "completed");
      assert.equal((await db.select().from(driveItems).where(and(eq(driveItems.parentId, rootId), eq(driveItems.name, "Concurrent")))).length, 1);
    });
    await t.test("cancelled and expired previews never create items and cannot be replayed", async () => {
      const cancelled = await save({ operation: "create_folder", name: "Cancelled", parentId: rootId });
      assert.equal((await approved({ ...cancelled, decision: "cancel" })).status, "cancelled");
      assert.equal((await run(ctx, () => approveChatAction(cancelled))).success, false);
      const expired = await save({ operation: "create_folder", name: "Expired", parentId: rootId }, { expiresAt: new Date(Date.now() - 1000).toISOString() });
      assert.equal((await approved(expired)).status, "failed");
      assert.deepEqual(await db.select().from(driveItems).where(and(eq(driveItems.parentId, rootId), inArray(driveItems.name, ["Cancelled", "Expired"]))), []);
    });
    await t.test("rename and move use the saved request and preserve real event/index hooks", async () => {
      const created = await approved(await save({ operation: "create_folder", name: "Before rename", parentId: rootId }));
      const id = created.result!.itemIds[0];
      assert.equal((await approved(await save({ operation: "rename_item", itemId: id, name: "After rename" }))).status, "completed");
      const moved = await approved(await save({ operation: "move_items", itemIds: [id], parentId: destinationId }));
      assert.equal(moved.status, "completed");
      assert.deepEqual(moved.result, { itemIds: [id], names: ["After rename"] });
      const [row] = await db.select().from(driveItems).where(eq(driveItems.id, id));
      assert.equal(row.name, "After rename");
      assert.equal(row.parentId, destinationId);
      const events = await db.select({ action: driveEvents.action }).from(driveEvents).where(eq(driveEvents.itemId, id));
      assert.deepEqual(events.map((event) => event.action).sort(), ["create_folder", "move", "rename"]);
    });
    await t.test("changed source snapshots and newly protected/excluded destinations fail closed", async () => {
      const created = await approved(await save({ operation: "create_folder", name: "Stale source", parentId: rootId }));
      const id = created.result!.itemIds[0];
      const stale = await save({ operation: "rename_item", itemId: id, name: "Must not apply" });
      await db.update(driveItems).set({ name: "Changed after preview", updatedAt: new Date(Date.now() + 1000) }).where(eq(driveItems.id, id));
      assert.equal((await approved(stale)).status, "failed");
      assert.equal((await db.select().from(driveItems).where(eq(driveItems.id, id)))[0].name, "Changed after preview");
      for (const mode of ["protected", "excluded", "revoked"] as const) {
        const parentId = mode === "revoked" ? sharedDestinationId : destinationId;
        const proposal = await save({ operation: "create_folder", name: `Blocked ${mode}`, parentId });
        const passwordVersion = randomUUID();
        await db.update(driveItems).set(mode === "protected" ? { passwordHash: "fixture", passwordVersion } : mode === "excluded" ? { searchExcluded: true } : { memberRole: "viewer" }).where(eq(driveItems.id, parentId));
        if (mode === "protected") await db.insert(driveFolderUnlocks).values({ folderId: parentId, sessionId: ctx.sessionId, passwordVersion, expiresAt: new Date(Date.now() + 60_000) });
        const blocked = await run(ctx, () => approveChatAction(proposal));
        if (blocked.success) assert.equal(blocked.data.status, "failed");
        assert.equal((await storedApproval(proposal.messageId)).status, "failed");
        assert.deepEqual(await db.select({ id: driveItems.id }).from(driveItems).where(and(eq(driveItems.parentId, parentId), eq(driveItems.name, `Blocked ${mode}`))), []);
        await db.update(driveItems).set({ passwordHash: null, passwordVersion: null, searchExcluded: false, ...(mode === "revoked" ? { memberRole: "editor" as const } : {}) }).where(eq(driveItems.id, parentId));
      }
    });
    await t.test("two same-name approvals cannot silently replace or create colliding items", async () => {
      const first = await save({ operation: "create_folder", name: "Collision", parentId: rootId });
      const second = await save({ operation: "create_folder", name: "collision", parentId: rootId });
      const results = await Promise.all([approved(first), approved(second)]);
      assert.deepEqual(results.map((result) => result.status).sort(), ["completed", "failed"]);
      const rows = await db.select().from(driveItems).where(and(eq(driveItems.parentId, rootId), inArray(driveItems.name, ["Collision", "collision"])));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].trashedAt, null);
    });
    await t.test("generated UTF-8 files and digest-bound attachments use PUT and atomic upload publication", async () => {
      const content = "# Plan\n\nExact approved text: café ☕\n";
      const file = await approved(await save({ operation: "create_file", name: "plan.md", content, mimeType: "text/markdown", parentId: rootId }));
      assert.equal(file.status, "completed", file.error);
      const fileId = file.result!.itemIds[0];
      const [row] = await db.select().from(driveItems).where(eq(driveItems.id, fileId));
      assert.equal(row.state, "complete");
      assert.equal(row.size, Buffer.byteLength(content));
      assert.equal(objects.get(row.objectKey!)!.bytes.toString("utf8"), content);
      assert.equal((await db.select().from(driveUploadWork).where(eq(driveUploadWork.id, fileId)))[0].status, "published");
      assert.equal((await db.select().from(driveSearchDocs).where(eq(driveSearchDocs.itemId, fileId)))[0].status, "queued");
      const saved = await approved({ ...await save({ ...attachment, parentId: rootId }), attachmentData: original.toString("base64") });
      assert.equal(saved.status, "completed", saved.error);
      const [savedRow] = await db.select().from(driveItems).where(eq(driveItems.id, saved.result!.itemIds[0]));
      assert.deepEqual(objects.get(savedRow.objectKey!)!.bytes, original);
      assert.deepEqual(putBytes, [Buffer.from(content), original]);
    });
    await t.test("changed attachment bytes consume approval without reserving an upload", async () => {
      const proposal = await save({ ...attachment, name: "tampered.txt", parentId: rootId });
      const changed = Buffer.from(original);
      changed[0] ^= 1;
      assert.equal((await approved({ ...proposal, attachmentData: changed.toString("base64") })).status, "failed");
      assert.equal((await run(ctx, () => approveChatAction({ ...proposal, attachmentData: original.toString("base64") }))).success, false);
      assert.deepEqual(await db.select().from(driveItems).where(and(eq(driveItems.parentId, rootId), eq(driveItems.name, "tampered.txt"))), []);
    });
    await t.test("collision appearing during PUT cancels rather than publishes or overwrites", async () => {
      const proposal = await save({ operation: "create_file", name: "late-collision.txt", content: "never publish", mimeType: "text/plain", parentId: rootId });
      const collisionId = randomUUID();
      beforePut = () => withDriveTransaction("write", async (tx) => {
        await tx.insert(driveItems).values({ id: collisionId, name: "late-collision.txt", parentId: rootId, kind: "folder", state: "complete", ownerId: ctx.userId });
      });
      try {
        assert.equal((await approved(proposal)).status, "failed");
      } finally { beforePut = undefined; }
      const rows = await db.select().from(driveItems).where(and(eq(driveItems.parentId, rootId), eq(driveItems.name, "late-collision.txt")));
      assert.deepEqual(rows.map((row) => row.id), [collisionId]);
      assert.equal(rows[0].trashedAt, null);
    });
    await t.test("generated-file source dependencies are reauthorized before reservation and never returned after revocation", async () => {
      const sourceId = randomUUID();
      await db.insert(driveItems).values({ id: sourceId, name: "Shared source.txt", parentId: sharedDestinationId, ownerId: other.userId, accessMode: "inherit", kind: "file", state: "complete", size: 11, mimeType: "text/plain", objectKey: `files/${sourceId}/source`, etag: '"source-fixture"' });
      for (const mode of ["unshared", "excluded", "protected"] as const) {
        const proposal = await save({ operation: "create_file", name: `derived-${mode}.txt`, content: "Source-derived private content", mimeType: "text/plain", parentId: null }, {}, chatId, [sourceId]);
        assert.deepEqual((await storedApproval(proposal.messageId)).sourceItemIds, [sourceId]);
        await db.update(driveItems).set(mode === "unshared" ? { accessMode: "private" } : mode === "excluded" ? { searchExcluded: true } : { passwordHash: "fixture", passwordVersion: randomUUID() }).where(eq(driveItems.id, sharedDestinationId));
        try {
          const result = await run(ctx, () => approveChatAction(proposal));
          assert.equal(result.success, false);
          assert.equal((await storedApproval(proposal.messageId)).status, "failed");
          assert.deepEqual(await db.select({ id: driveItems.id }).from(driveItems).where(and(eq(driveItems.ownerId, ctx.userId), eq(driveItems.name, `derived-${mode}.txt`))), []);
        } finally {
          await db.update(driveItems).set({ accessMode: "members", searchExcluded: false, passwordHash: null, passwordVersion: null }).where(eq(driveItems.id, sharedDestinationId));
        }
      }
      const inflight = await save({ operation: "create_file", name: "derived-inflight.txt", content: "Must not survive source revocation", mimeType: "text/plain", parentId: rootId }, {}, chatId, [sourceId]);
      afterPut = async () => { await db.update(driveItems).set({ searchExcluded: true }).where(eq(driveItems.id, sharedDestinationId)); };
      try {
        assert.equal((await run(ctx, () => approveChatAction(inflight))).success, false);
        assert.equal((await storedApproval(inflight.messageId)).status, "failed");
        assert.deepEqual(await db.select({ id: driveItems.id }).from(driveItems).where(and(eq(driveItems.parentId, rootId), eq(driveItems.name, "derived-inflight.txt"))), []);
      } finally {
        afterPut = undefined;
        await db.update(driveItems).set({ searchExcluded: false }).where(eq(driveItems.id, sharedDestinationId));
      }
    });
    await t.test("ordinary finalizers cannot publish guarded uploads or accept their published fast path", async () => {
      const proposal = await save({ operation: "create_file", name: "guarded-upload.txt", content: "original approved bytes", mimeType: "text/plain", parentId: rootId });
      let uploadId = "";
      afterPut = async (id) => {
        uploadId = id;
        const [work] = await db.select().from(driveUploadWork).where(eq(driveUploadWork.id, id));
        assert.equal(work.mutationGuardId, proposal.stepId);
        const result = await independentRequest.runInAsyncScope(() => run(ctx, () => completeUpload(id)));
        assert.equal(result.success, false);
        assert.equal((await db.select().from(driveItems).where(eq(driveItems.id, id)))[0].state, "pending");
        assert.equal((await storedApproval(proposal.messageId)).status, "executing");
      };
      try {
        assert.equal((await approved(proposal)).status, "completed");
      } finally { afterPut = undefined; }
      assert.equal((await run(ctx, () => completeUpload(uploadId))).success, false);
      assert.deepEqual((await storedApproval(proposal.messageId)).result?.itemIds, [uploadId]);
    });
    await t.test("a rejected completion receipt rolls back the Drive mutation itself", async () => {
      const proposal = await save({ operation: "create_folder", name: "Atomic receipt", parentId: rootId });
      const trigger = `receipt_${randomUUID().replaceAll("-", "")}`;
      const fn = `${trigger}_fn`;
      await db.execute(sql.raw(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id = '${proposal.messageId}'::uuid AND EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.steps) step WHERE step #>> '{approval,status}' = 'completed') THEN
          RAISE EXCEPTION 'Simulated receipt storage failure';
        END IF; RETURN NEW; END; $$`));
      try {
        await db.execute(sql.raw(`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON drive_chat_messages FOR EACH ROW EXECUTE FUNCTION "${fn}"()`));
        assert.equal((await approved(proposal)).status, "failed");
        assert.deepEqual(await db.select({ id: driveItems.id }).from(driveItems).where(and(eq(driveItems.parentId, rootId), eq(driveItems.name, "Atomic receipt"))), []);
      } finally {
        await db.execute(sql.raw(`DROP TRIGGER IF EXISTS "${trigger}" ON drive_chat_messages`));
        await db.execute(sql.raw(`DROP FUNCTION "${fn}"()`));
      }
    });
    await t.test("post-commit response failure preserves the durable completed outcome", async () => {
      const proposal = await save({ operation: "create_file", name: "durable-result.txt", content: "committed despite response hook", mimeType: "text/plain", parentId: rootId });
      failAfterResponse = true;
      let outcome: DriveChatApproval;
      try {
        outcome = await approved(proposal);
      } finally { failAfterResponse = false; }
      assert.equal(outcome.status, "completed");
      assert.deepEqual((await storedApproval(proposal.messageId)).result, outcome.result);
      assert.equal((await db.select().from(driveItems).where(eq(driveItems.id, outcome.result!.itemIds[0])))[0].state, "complete");
      assert.equal((await run(ctx, () => approveChatAction(proposal))).success, false);
      const [message] = await db.select().from(driveChatMessages).where(eq(driveChatMessages.id, proposal.messageId));
      await db.update(driveChatMessages).set({ steps: message.steps.map((step) => ({ ...step, approval: { ...step.approval!, expiresAt: new Date(Date.now() - 1).toISOString() } })) }).where(eq(driveChatMessages.id, proposal.messageId));
      await recoverExpiredChatApprovals(ctx, chatId);
      assert.equal((await storedApproval(proposal.messageId)).status, "completed");
      assert.deepEqual((await storedApproval(proposal.messageId)).result, outcome.result);
    });
    await t.test("expired executing claims are fenced and uploads cancelled without replay", async () => {
      const proposal = await save({ operation: "create_file", name: "expired-inflight.txt", content: "must never publish", mimeType: "text/plain", parentId: rootId });
      let uploadId = "";
      afterPut = async (id) => {
        uploadId = id;
        await recoverExpiredChatApprovals(ctx, chatId);
        assert.equal((await storedApproval(proposal.messageId)).status, "executing");
        const [message] = await db.select().from(driveChatMessages).where(eq(driveChatMessages.id, proposal.messageId));
        await db.update(driveChatMessages).set({ steps: message.steps.map((step) => ({ ...step, approval: { ...step.approval!, expiresAt: new Date(Date.now() - 1).toISOString() } })) }).where(eq(driveChatMessages.id, proposal.messageId));
        await independentRequest.runInAsyncScope(() => run(ctx, () => recoverExpiredChatApprovals(ctx, chatId)));
        assert.equal((await storedApproval(proposal.messageId)).status, "failed");
      };
      try {
        assert.equal((await approved(proposal)).status, "failed");
      } finally { afterPut = undefined; }
      assert.deepEqual(await db.select().from(driveItems).where(eq(driveItems.id, uploadId)), []);
      assert.equal((await db.select().from(driveUploadWork).where(eq(driveUploadWork.id, uploadId)))[0].status, "cancelled");
      assert.equal((await run(ctx, () => approveChatAction(proposal))).success, false);
      const abandoned = await save({ operation: "create_folder", name: "Abandoned", parentId: rootId }, { status: "executing", expiresAt: new Date(Date.now() - 1).toISOString() });
      await recoverExpiredChatApprovals(ctx, chatId);
      assert.equal((await storedApproval(abandoned.messageId)).status, "failed");
      assert.deepEqual(await db.select({ id: driveItems.id }).from(driveItems).where(and(eq(driveItems.parentId, rootId), eq(driveItems.name, "Abandoned"))), []);
    });
  } finally {
    t.mock.restoreAll();
    independentRequest.emitDestroy();
    try {
      await db.delete(driveChats).where(inArray(driveChats.id, [chatId, otherChatId]));
      await db.delete(driveItems).where(inArray(driveItems.ownerId, [ctx.userId, other.userId]));
      if (uploadIds.size) await db.delete(driveUploadWork).where(inArray(driveUploadWork.id, [...uploadIds]));
      await db.delete(driveEvents).where(inArray(driveEvents.actorId, [ctx.userId, other.userId]));
      await db.delete(session).where(inArray(session.id, [ctx.sessionId, other.sessionId]));
      await db.delete(user).where(inArray(user.id, [ctx.userId, other.userId]));
    } finally {
      globals.oroleDatabase = previousDb;
      globals.oroleStorageClaims = previousClaims;
      for (const key of envKeys) if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
      await Promise.all([client.end(), claims.end()]);
    }
  }
});
