import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { EMAIL_DOMAIN_WHITELIST } from "./auth-policy";
import { authThrottle, session, user } from "./auth-schema";
import { startChatTurn } from "./chat";
import { driveChatMessages, driveChats } from "./chat-schema";
import type { Database } from "./db";
import type { DriveContext } from "./drive-access";
import { DriveError } from "./drive-errors";
import { driveItems } from "./drive-schema";

const signal = new AbortController().signal;
const textOf = (content: unknown) => typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("") : "";

// This opt-in suite never falls back to the application's DATABASE_URL.
test("chats stay private and never resend text from sources the member lost", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 2 });
  const db = drizzle(client);
  const databaseGlobal = globalThis as typeof globalThis & { oroleDatabase?: Database };
  const previous = databaseGlobal.oroleDatabase;
  databaseGlobal.oroleDatabase = db;
  const [memberId, otherId] = [randomUUID(), randomUUID()];
  const ctx = (userId: string): DriveContext => ({ sessionId: randomUUID(), userId, email: `${userId}@${EMAIL_DOMAIN_WHITELIST[0]}` });
  const member = ctx(memberId);
  const fileId = randomUUID();
  try {
    await db.insert(user).values([memberId, otherId].map((id) => ({ id, name: id, email: `${id}@${EMAIL_DOMAIN_WHITELIST[0]}`, emailVerified: true })));
    await db.insert(session).values({ id: member.sessionId, token: randomUUID(), userId: memberId, expiresAt: new Date(Date.now() + 600_000) });
    await db.insert(driveItems).values({ id: fileId, name: "salaris.txt", kind: "file", state: "complete", ownerId: memberId, size: 1, mimeType: "text/plain", objectKey: `files/${fileId}/x`, etag: "\"e\"" });
    const first = await startChatTurn(member, { message: "Wat verdien ik?" }, signal);
    await db.insert(driveChatMessages).values({ id: randomUUID(), chatId: first.chatId, role: "assistant", content: "Je verdient 4.000 euro [1].", citations: [{ n: 1, itemId: fileId, name: "salaris.txt", location: null }] });

    await t.test("history keeps answers whose sources are still readable", async () => {
      const turn = await startChatTurn(member, { chatId: first.chatId, message: "En vorig jaar?" }, signal);
      assert.deepEqual(turn.history.map((message) => textOf(message.content)), ["Wat verdien ik?", "Je verdient 4.000 euro [1].", "En vorig jaar?"]);
    });

    await t.test("once a source is out of reach, its answer is withheld from the model", async () => {
      await db.update(driveItems).set({ trashedAt: new Date() }).where(eq(driveItems.id, fileId));
      const turn = await startChatTurn(member, { chatId: first.chatId, message: "Nog iets?" }, signal);
      assert.ok(!turn.history.some((message) => textOf(message.content).includes("4.000")));
      assert.match(textOf(turn.history[1].content), /omitted/);
    });

    await t.test("another member cannot continue someone else's chat", async () => {
      await assert.rejects(startChatTurn(ctx(otherId), { chatId: first.chatId, message: "Laat zien" }, signal), /no longer available/);
    });

    await t.test("regenerating answers the last question again and drops the old answer", async () => {
      const { chatId } = await startChatTurn(member, { message: "Wanneer vertrekt de boot?" }, signal);
      const answerId = randomUUID();
      await db.insert(driveChatMessages).values({ id: answerId, chatId, role: "assistant", content: "Om 9 uur.", citations: [] });
      const turn = await startChatTurn(member, { chatId, regenerate: true }, signal);
      assert.equal(textOf(turn.history.at(-1)!.content), "Wanneer vertrekt de boot?");
      const rows = await db.select().from(driveChatMessages).where(eq(driveChatMessages.chatId, chatId));
      assert.deepEqual(rows.map((row) => row.role), ["user"], "no duplicate question, and the old answer is gone");
    });

    await t.test("only verified members can be mentioned", async () => {
      const turn = await startChatTurn(member, { message: "Wat heeft @Other gedeeld?", mentionIds: [otherId, "not-a-member"] }, signal);
      assert.deepEqual(turn.mentions.map((mention) => mention.id), [otherId]);
      assert.match(textOf(turn.history.at(-1)!.content), new RegExp(`ownerId ${otherId}`));
    });

    await t.test("structured spreadsheet results are not resent after source revocation", async () => {
      await db.update(driveItems).set({ trashedAt: null }).where(eq(driveItems.id, fileId));
      const { chatId } = await startChatTurn(member, { message: "Show the total." }, signal);
      await db.insert(driveChatMessages).values({
        id: randomUUID(), chatId, role: "assistant", content: "The total is in the table.",
        steps: [{ id: randomUUID(), tool: "calculate_spreadsheet", status: "done", label: "Total", itemId: fileId, table: { title: "Salary", columns: ["Total"], rows: [[4271]], truncated: false } }],
      });
      const before = await startChatTurn(member, { chatId, message: "What is in that table?" }, signal);
      assert.ok(before.history.some((message) => textOf(message.content).includes("4271")));
      await db.update(driveItems).set({ trashedAt: new Date() }).where(eq(driveItems.id, fileId));
      const after = await startChatTurn(member, { chatId, message: "Repeat the table." }, signal);
      assert.ok(after.history.every((message) => !textOf(message.content).includes("4271")));
    });

    await t.test("regeneration cannot erase an action that was approved", async () => {
      const { chatId } = await startChatTurn(member, { message: "Create Notes." }, signal);
      const answerId = randomUUID();
      await db.insert(driveChatMessages).values({
        id: answerId, chatId, role: "assistant", content: "Folder creation approved.",
        steps: [{ id: randomUUID(), tool: "create_folder", status: "done", label: "Notes", approval: {
          request: { operation: "create_folder", name: "Notes", parentId: null }, title: "Create Notes", details: ["My drive"],
          status: "completed", expiresAt: new Date(Date.now() + 60_000).toISOString(), snapshots: [], result: { itemIds: [], names: ["Notes"] },
        } }],
      });
      await assert.rejects(startChatTurn(member, { chatId, regenerate: true }, signal), DriveError);
      assert.deepEqual((await db.select({ id: driveChatMessages.id }).from(driveChatMessages).where(eq(driveChatMessages.id, answerId))).map((row) => row.id), [answerId]);
    });

    await t.test("later save requests retain attachment identity but not the original contents", async () => {
      const id = randomUUID();
      const first = await startChatTurn(member, { message: "Read this note.", attachments: [{ id, name: "note.txt", mimeType: "text/plain", data: Buffer.from("private original note text").toString("base64") }] }, signal);
      const next = await startChatTurn(member, { chatId: first.chatId, message: "Save that attachment." }, signal);
      assert.equal(next.attachments[0].id, id);
      assert.equal(next.attachments[0].sha256, first.attachments[0].sha256);
      assert.ok(next.history.every((message) => !textOf(message.content).includes("private original note text")));
    });
  } finally {
    databaseGlobal.oroleDatabase = previous;
    try {
      await db.delete(authThrottle).where(inArray(authThrottle.key, [`chat:${memberId}`, `chat:${otherId}`]));
      await db.delete(driveChats).where(inArray(driveChats.userId, [memberId, otherId]));
      await db.delete(driveItems).where(eq(driveItems.id, fileId));
      await db.delete(user).where(inArray(user.id, [memberId, otherId]));
    } finally {
      await client.end();
    }
  }
});
