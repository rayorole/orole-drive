import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "@/lib/auth-schema";

/** A numbered source in an answer. Access is re-checked whenever it is shown; the name is a snapshot. */
export type ChatCitation = { n: number; itemId: string; name: string; location: string | null };

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("drive_chat_messages_chat_idx").on(table.chatId, table.createdAt),
  check("drive_chat_messages_role_valid", sql`${table.role} in ('user', 'assistant')`),
]);
