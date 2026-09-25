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
import { driveItems } from "./drive-schema";

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
    const first = await startChatTurn(member, { message: "Wat verdien ik?" });
    await db.insert(driveChatMessages).values({ id: randomUUID(), chatId: first.chatId, role: "assistant", content: "Je verdient 4.000 euro [1].", citations: [{ n: 1, itemId: fileId, name: "salaris.txt", location: null }] });

    await t.test("history keeps answers whose sources are still readable", async () => {
      const turn = await startChatTurn(member, { chatId: first.chatId, message: "En vorig jaar?" });
      assert.deepEqual(turn.history.map((message) => message.content), ["Wat verdien ik?", "Je verdient 4.000 euro [1].", "En vorig jaar?"]);
    });

    await t.test("once a source is out of reach, its answer is withheld from the model", async () => {
      await db.update(driveItems).set({ trashedAt: new Date() }).where(eq(driveItems.id, fileId));
      const turn = await startChatTurn(member, { chatId: first.chatId, message: "Nog iets?" });
      assert.ok(!turn.history.some((message) => String(message.content).includes("4.000")));
      assert.match(String(turn.history[1].content), /omitted/);
    });

    await t.test("another member cannot continue someone else's chat", async () => {
      await assert.rejects(startChatTurn(ctx(otherId), { chatId: first.chatId, message: "Laat zien" }), /no longer available/);
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
