import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "@/lib/auth-schema";
import type { DriveChatAttachment, DriveChatStep } from "@/lib/drive-types";

/**
 * A numbered source in an answer. Access is re-checked whenever it is shown: the name, folder path
 * and quoted passage are snapshots and are only returned while the member can still open the file.
 */
export type ChatCitation = { n: number; itemId: string; name: string; location: string | null; quote?: string | null; path?: string[] };

/** "Ask your drive" conversations. Private to their member: every query filters by user_id. */
export const driveChats = pgTable("drive_chats", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("drive_chats_user_updated_idx").on(table.userId, table.updatedAt.desc()),
]);

export const driveChatMessages = pgTable("drive_chat_messages", {
  id: uuid("id").primaryKey(),
  chatId: uuid("chat_id").notNull().references(() => driveChats.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  citations: jsonb("citations").$type<ChatCitation[]>().notNull().default([]),
  /** Assistant only: the tool steps of the turn (searches, reads, comparisons), for the timeline. */
  steps: jsonb("steps").$type<DriveChatStep[]>().notNull().default([]),
  /** User only: names of files attached to the question. Their contents are never stored. */
  attachments: jsonb("attachments").$type<DriveChatAttachment[]>().notNull().default([]),
  /** Assistant only: the member's thumbs up or down. */
  feedback: text("feedback", { enum: ["up", "down"] }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("drive_chat_messages_chat_idx").on(table.chatId, table.createdAt),
  check("drive_chat_messages_role_valid", sql`${table.role} in ('user', 'assistant')`),
  check("drive_chat_messages_feedback_valid", sql`${table.feedback} is null or ${table.feedback} in ('up', 'down')`),
]);
