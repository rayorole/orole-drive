"use server";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { readableCitedItems } from "@/lib/chat";
import { driveChatMessages, driveChats } from "@/lib/chat-schema";
import { getDb } from "@/lib/db";
import { driveAction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import type { ActionResult, DriveAssistantStatus, DriveChat, DriveChatSummary } from "@/lib/drive-types";
import { isChatConfigured, isSearchConfigured, searchConfig } from "@/lib/search-config";
import { toDriveItem } from "@/lib/storage";

const chatIdSchema = z.uuid("Choose a valid chat.");
/** The member's own latest question, never answer text (which can quote files). */
const lastQuestion = sql<string>`coalesce((
  select question.content from ${driveChatMessages} question
  where question.chat_id = ${driveChats.id} and question.role = 'user'
  order by question.created_at desc limit 1
), '')`;

/** This member's own chats, newest first. Chats are never shared. */
export async function listChats(): Promise<ActionResult<DriveChatSummary[]>> {
  return driveAction(async (ctx) => {
    const rows = await getDb().select({ id: driveChats.id, title: driveChats.title, updatedAt: driveChats.updatedAt, preview: lastQuestion }).from(driveChats)
      .where(eq(driveChats.userId, ctx.userId)).orderBy(desc(driveChats.updatedAt)).limit(100);
    return rows.map((row) => ({ ...row, preview: row.preview.replace(/\s+/g, " ").slice(0, 120), updatedAt: row.updatedAt.toISOString() }));
  }, "read");
}

/**
 * One of this member's chats. Every citation and file-bound tool step is re-authorized now: for files the
 * member can no longer open, citations carry `item: null` without quote or path, and compared lines are dropped.
 */
export async function getChat(id: string): Promise<ActionResult<DriveChat>> {
  return driveAction(async (ctx) => {
    const chatId = chatIdSchema.parse(id);
    const [chat] = await getDb().select({ id: driveChats.id, title: driveChats.title, updatedAt: driveChats.updatedAt, preview: lastQuestion }).from(driveChats)
      .where(and(eq(driveChats.id, chatId), eq(driveChats.userId, ctx.userId)));
    if (!chat) throw new DriveError("This chat is no longer available.");
    const messages = await getDb().select().from(driveChatMessages).where(eq(driveChatMessages.chatId, chat.id)).orderBy(asc(driveChatMessages.createdAt));
    const readable = await readableCitedItems(ctx, messages.flatMap((message) => [
      ...message.citations.map((citation) => citation.itemId),
      ...message.steps.flatMap((step) => step.itemId ? [step.itemId] : []),
    ]));
    return {
      id: chat.id, title: chat.title, updatedAt: chat.updatedAt.toISOString(), preview: chat.preview.slice(0, 120),
      messages: messages.map((message) => ({
        id: message.id, role: message.role, content: message.content, createdAt: message.createdAt.toISOString(),
        attachments: message.attachments, feedback: message.feedback,
        steps: message.steps.map((step) => step.itemId && !readable.has(step.itemId) ? { ...step, label: step.tool === "list_drive_items" ? "Unavailable folder" : "Unavailable file", diff: undefined } : step),
        citations: message.citations.map((citation) => {
          const row = readable.get(citation.itemId);
          return row
            ? { n: citation.n, itemId: citation.itemId, name: row.name, location: citation.location, quote: citation.quote ?? null, path: citation.path ?? [], item: { ...toDriveItem(row), ...row.flags } }
            : { n: citation.n, itemId: citation.itemId, name: citation.name, location: citation.location, quote: null, path: [], item: null };
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

/** Thumbs up or down on one of this member's answers; null clears it. */
export async function setChatFeedback(input: { messageId: string; feedback: "up" | "down" | null }): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    const { messageId, feedback } = z.object({ messageId: z.uuid(), feedback: z.enum(["up", "down"]).nullable() }).parse(input);
    const updated = await getDb().update(driveChatMessages).set({ feedback }).where(and(
      eq(driveChatMessages.id, messageId), eq(driveChatMessages.role, "assistant"),
      sql`${driveChatMessages.chatId} in (select id from ${driveChats} where ${driveChats.userId} = ${ctx.userId})`,
    )).returning({ id: driveChatMessages.id });
    if (!updated.length) throw new DriveError("This answer is no longer available.");
  }, "read");
}

export async function deleteChat(id: string): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    const chatId = chatIdSchema.parse(id);
    const deleted = await getDb().delete(driveChats).where(and(eq(driveChats.id, chatId), eq(driveChats.userId, ctx.userId))).returning({ id: driveChats.id });
    if (!deleted.length) throw new DriveError("This chat is no longer available.");
  });
}

/** What Ask AI is running on, for its server panel. No secrets. */
export async function getAssistantStatus(): Promise<ActionResult<DriveAssistantStatus>> {
  return driveAction(async () => ({
    model: isChatConfigured() ? searchConfig()!.chatModel : "",
    semanticIndex: isSearchConfigured(),
    captions: isChatConfigured(),
  }), "read");
}
