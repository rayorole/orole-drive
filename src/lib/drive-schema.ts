import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const driveItems = pgTable(
  "drive_items",
  {
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    kind: text("kind", { enum: ["file", "folder"] }).notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => driveItems.id, {
      onDelete: "restrict",
    }),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mimeType: varchar("mime_type", { length: 127 }),
    objectKey: varchar("object_key", { length: 128 }).unique(),
    etag: text("etag"),
    state: text("state", { enum: ["pending", "complete"] }).notNull(),
    publicToken: varchar("public_token", { length: 43 }).unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("drive_items_parent_state_idx").on(table.parentId, table.state),
    index("drive_items_state_updated_idx").on(table.state, table.updatedAt),
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
