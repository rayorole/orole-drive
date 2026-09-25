import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { session, user } from "@/lib/auth-schema";

export const driveItems = pgTable(
  "drive_items",
  {
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    description: varchar("description", { length: 2_000 }).notNull().default(""),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    folderColor: text("folder_color", { enum: ["blue", "green", "amber", "red", "violet", "gray"] }),
    kind: text("kind", { enum: ["file", "folder"] }).notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => driveItems.id, {
      onDelete: "restrict",
    }),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mimeType: varchar("mime_type", { length: 127 }),
    objectKey: varchar("object_key", { length: 128 }).unique(),
    multipartUploadId: text("multipart_upload_id"),
    etag: text("etag"),
    state: text("state", { enum: ["pending", "complete"] }).notNull(),
    publicToken: varchar("public_token", { length: 43 }).unique(),
    sharedByEmail: varchar("shared_by_email", { length: 254 }),
    publicExpiresAt: timestamp("public_expires_at", { withTimezone: true }),
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    trashRootId: uuid("trash_root_id"),
    deletionStartedAt: timestamp("deletion_started_at", { withTimezone: true }),
    passwordHash: text("password_hash"),
    passwordVersion: uuid("password_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("drive_items_parent_state_idx").on(table.parentId, table.state),
    index("drive_items_state_updated_idx").on(table.state, table.updatedAt),
    index("drive_items_trashed_at_idx").on(table.trashedAt),
    check("drive_items_folder_color_valid", sql`${table.folderColor} is null or (
      ${table.kind} = 'folder' and ${table.folderColor} in ('blue', 'green', 'amber', 'red', 'violet', 'gray')
    )`),
    check("drive_items_password_folder_only", sql`${table.passwordHash} is null or ${table.kind} = 'folder'`),
    check("drive_items_password_version_pair", sql`(
      ${table.passwordHash} is null and ${table.passwordVersion} is null
    ) or (
      ${table.passwordHash} is not null and length(${table.passwordHash}) > 0
      and ${table.passwordVersion} is not null
    )`),
    check("drive_items_name_valid", sql`char_length(${table.name}) between 1 and 255`),
    check("drive_items_not_own_parent", sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`),
    check(
      "drive_items_shape_valid",
      sql`(
        ${table.kind} = 'folder' and ${table.state} = 'complete'
        and ${table.size} = 0 and ${table.mimeType} is null
        and ${table.objectKey} is null and ${table.etag} is null
        and ${table.publicToken} is null
      ) or (
        ${table.kind} = 'file' and ${table.size} between 0 and 5368709120
        and ${table.mimeType} is not null and ${table.objectKey} is not null
        and (
          (${table.state} = 'pending' and ${table.etag} is null and ${table.publicToken} is null)
          or (${table.state} = 'complete' and ${table.etag} is not null)
        )
      )`,
    ),
  ],
);

export type DriveRow = typeof driveItems.$inferSelect;

export const driveFolderUnlocks = pgTable("drive_folder_unlocks", {
  sessionId: text("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
  folderId: uuid("folder_id").notNull().references(() => driveItems.id, { onDelete: "cascade" }),
  passwordVersion: uuid("password_version").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.folderId] }),
  index("drive_folder_unlocks_expires_idx").on(table.expiresAt),
]);

export const driveFavorites = pgTable("drive_favorites", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => driveItems.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.itemId] }),
]);

export const driveActivity = pgTable("drive_activity", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => driveItems.id, { onDelete: "cascade" }),
  accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.itemId] }),
  index("drive_activity_accessed_at_idx").on(table.accessedAt),
]);
