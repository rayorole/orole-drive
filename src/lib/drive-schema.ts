import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  jsonb,
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
    folderEmoji: varchar("folder_emoji", { length: 64 }),
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
    /** Folders only: this folder and everything inside it stay out of AI search. */
    searchExcluded: boolean("search_excluded").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Member responsible for the current bytes (quota attribution), not the immutable owner. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    accessMode: text("access_mode", { enum: ["private", "inherit", "members", "selected"] }).notNull().default("private"),
    memberRole: text("member_role", { enum: ["viewer", "editor"] }).notNull().default("viewer"),
    /**
     * Pending uploads only: the complete file this upload becomes a new version of.
     * Its object key lives under the replaced file's id so it can be promoted without copying bytes.
     */
    replacesId: uuid("replaces_id").references((): AnyPgColumn => driveItems.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("drive_items_parent_state_idx").on(table.parentId, table.state),
    index("drive_items_created_by_idx").on(table.createdBy),
    index("drive_items_owner_idx").on(table.ownerId),
    check("drive_items_access_mode_valid", sql`${table.accessMode} in ('private', 'inherit', 'members', 'selected')`),
    check("drive_items_member_role_valid", sql`${table.memberRole} in ('viewer', 'editor')`),
    index("drive_items_replaces_idx").on(table.replacesId),
    check("drive_items_replaces_pending_file", sql`${table.replacesId} is null or (${table.kind} = 'file' and ${table.state} = 'pending' and ${table.replacesId} <> ${table.id})`),
    index("drive_items_state_updated_idx").on(table.state, table.updatedAt),
    index("drive_items_trashed_at_idx").on(table.trashedAt),
    check("drive_items_folder_color_valid", sql`${table.folderColor} is null or (
      ${table.kind} = 'folder' and ${table.folderColor} in ('blue', 'green', 'amber', 'red', 'violet', 'gray')
    )`),
    check("drive_items_folder_emoji_valid", sql`${table.folderEmoji} is null or (${table.kind} = 'folder' and char_length(${table.folderEmoji}) between 1 and 64)`),
    check("drive_items_password_folder_only", sql`${table.passwordHash} is null or ${table.kind} = 'folder'`),
    check("drive_items_search_excluded_folder_only", sql`${table.searchExcluded} = false or ${table.kind} = 'folder'`),
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

/** Durable upload identity and cleanup intent, deliberately surviving pending-item cascades. */
export const driveUploadWork = pgTable("drive_upload_work", {
  id: uuid("id").primaryKey(),
  itemId: uuid("item_id").notNull(),
  objectKey: varchar("object_key", { length: 128 }).notNull().unique(),
  /** Single-PUT publication never writes the legacy final/staging identity. */
  publicationKey: varchar("publication_key", { length: 128 }).unique(),
  /** Server-only approval identity; ordinary upload finalizers cannot publish guarded work. */
  mutationGuardId: uuid("mutation_guard_id"),
  multipartUploadId: text("multipart_upload_id"),
  multipart: boolean("multipart").notNull().default(false),
  size: bigint("size", { mode: "number" }).notNull(),
  mimeType: varchar("mime_type", { length: 127 }).notNull(),
  status: text("status", { enum: ["pending", "cancelled", "published"] }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Last signed ticket expiry; cancelled tombstones outlive every outstanding bearer URL. */
  retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
}, (table) => [
  index("drive_upload_work_status_idx").on(table.status, table.retainUntil),
  check("drive_upload_work_status_valid", sql`${table.status} in ('pending', 'cancelled', 'published')`),
  check("drive_upload_work_publication_distinct", sql`${table.publicationKey} is null or ${table.publicationKey} <> ${table.objectKey}`),
]);

export type UploadWorkRow = typeof driveUploadWork.$inferSelect;

export const driveItemMembers = pgTable("drive_item_members", {
  itemId: uuid("item_id").notNull().references(() => driveItems.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["viewer", "editor"] }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.itemId, table.userId] }),
  index("drive_item_members_user_idx").on(table.userId),
  check("drive_item_members_role_valid", sql`${table.role} in ('viewer', 'editor')`),
]);

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

export const drivePinnedFolders = pgTable("drive_pinned_folders", {
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

/**
 * Earlier contents of a file, kept when a same-named upload replaces it. Object keys stay under
 * `files/<itemId>/`, so deleting the file (and its versions) never touches another item's bytes.
 */
export const driveFileVersions = pgTable("drive_file_versions", {
  id: uuid("id").primaryKey(),
  itemId: uuid("item_id").notNull().references(() => driveItems.id, { onDelete: "cascade" }),
  objectKey: varchar("object_key", { length: 128 }).notNull().unique(),
  size: bigint("size", { mode: "number" }).notNull(),
  mimeType: varchar("mime_type", { length: 127 }).notNull(),
  etag: text("etag").notNull(),
  /** Member who uploaded this content; null when unknown. */
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  /** When this content was uploaded (the file's updatedAt at the time). */
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  /** When newer content replaced it. */
  replacedAt: timestamp("replaced_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("drive_file_versions_item_idx").on(table.itemId, table.replacedAt),
  index("drive_file_versions_created_by_idx").on(table.createdBy),
  check("drive_file_versions_size_valid", sql`${table.size} between 0 and 5368709120`),
]);

export type DriveFileVersionRow = typeof driveFileVersions.$inferSelect;

export const DRIVE_EVENT_ACTIONS = [
  "upload", "create_folder", "rename", "move", "copy", "trash", "restore", "delete", "empty_trash",
  "share", "unshare", "new_version", "restore_version", "delete_version", "protect", "unprotect", "exclude_search", "include_search",
] as const;

/**
 * Shared activity history. Rows outlive the items they describe (no foreign key on itemId),
 * so names are snapshotted when the event happens.
 */
export const driveEvents = pgTable("drive_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
  actorEmail: varchar("actor_email", { length: 254 }).notNull(),
  action: text("action", { enum: DRIVE_EVENT_ACTIONS }).notNull(),
  itemId: uuid("item_id"),
  itemName: varchar("item_name", { length: 255 }).notNull(),
  itemKind: text("item_kind", { enum: ["file", "folder"] }).notNull(),
  /** Folder the item is in after the event; null for the drive root. */
  parentId: uuid("parent_id"),
  details: jsonb("details").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  /** Item sat inside a password-protected folder (or is one); readers redact it unless they can access it. */
  protected: boolean("protected").notNull().default(false),
}, (table) => [
  index("drive_events_at_idx").on(table.at),
  index("drive_events_item_idx").on(table.itemId, table.at),
  index("drive_events_parent_idx").on(table.parentId, table.at),
  index("drive_events_actor_idx").on(table.actorId, table.at),
]);

export type DriveEventRow = typeof driveEvents.$inferSelect;
