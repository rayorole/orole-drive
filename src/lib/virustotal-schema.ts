import { index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { driveItems } from "@/lib/drive-schema";

export const driveVirusScans = pgTable("drive_virus_scans", {
  itemId: uuid("item_id").primaryKey().references(() => driveItems.id, { onDelete: "cascade" }),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  analysisId: text("analysis_id"),
  status: text("status", { enum: ["unknown", "pending", "clean", "suspicious", "malicious"] }).notNull(),
  statsJson: text("stats_json"),
  permalink: text("permalink"),
  scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("drive_virus_scans_sha256_idx").on(table.sha256),
]);

export type DriveVirusScanRow = typeof driveVirusScans.$inferSelect;
