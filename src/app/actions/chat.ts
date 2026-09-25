"use server";

import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { readableCitedItems } from "@/lib/chat";
import { driveChatMessages, driveChats } from "@/lib/chat-schema";
import { getDb } from "@/lib/db";
import { driveAction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import type { ActionResult, DriveChat, DriveChatSummary } from "@/lib/drive-types";
import { toDriveItem } from "@/lib/storage";

const chatIdSchema = z.uuid("Choose a valid chat.");

/** This member's own chats, newest first. Chats are never shared. */
export async function listChats(): Promise<ActionResult<DriveChatSummary[]>> {
  return driveAction(async (ctx) => {
    const rows = await getDb().select({ id: driveChats.id, title: driveChats.title, updatedAt: driveChats.updatedAt }).from(driveChats)
      .where(eq(driveChats.userId, ctx.userId)).orderBy(desc(driveChats.updatedAt)).limit(100);
    return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
  }, "read");
}

/** One of this member's chats. Every citation is re-authorized now; unavailable ones carry `item: null`. */
export async function getChat(id: string): Promise<ActionResult<DriveChat>> {
  return driveAction(async (ctx) => {
    const chatId = chatIdSchema.parse(id);
    const [chat] = await getDb().select().from(driveChats).where(and(eq(driveChats.id, chatId), eq(driveChats.userId, ctx.userId)));
    if (!chat) throw new DriveError("This chat is no longer available.");
    const messages = await getDb().select().from(driveChatMessages).where(eq(driveChatMessages.chatId, chat.id)).orderBy(asc(driveChatMessages.createdAt));
    const readable = await readableCitedItems(ctx, messages.flatMap((message) => message.citations.map((citation) => citation.itemId)));
    return {
      id: chat.id, title: chat.title, updatedAt: chat.updatedAt.toISOString(),
      messages: messages.map((message) => ({
        id: message.id, role: message.role, content: message.content, createdAt: message.createdAt.toISOString(),
        citations: message.citations.map((citation) => {
          const row = readable.get(citation.itemId);
          return { ...citation, item: row ? { ...toDriveItem(row), ...row.flags } : null };
        }),
      })),
    };
  }, "read");
}

export async function renameChat(input: { id: string; title: string }): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    const { id, title } = z.object({ id: chatIdSchema, title: z.string().trim().min(1, "Enter a title.").max(80, "Titles can be up to 80 characters.") }).parse(input);
    const renamed = await getDb().update(driveChats).set({ title }).where(and(eq(driveChats.id, id), eq(driveChats.userId, ctx.userId))).returning({ id: driveChats.id });
    if (!renamed.length) throw new DriveError("This chat is no longer available.");
  });
}

export async function deleteChat(id: string): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    const chatId = chatIdSchema.parse(id);
    const deleted = await getDb().delete(driveChats).where(and(eq(driveChats.id, chatId), eq(driveChats.userId, ctx.userId))).returning({ id: driveChats.id });
    if (!deleted.length) throw new DriveError("This chat is no longer available.");
  });
}
