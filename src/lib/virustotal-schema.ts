import { index, pgTable, real, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
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

/** How worth scanning a file looks from its name and declared type; decides which files are looked up first. */
export const driveFileRisks = pgTable("drive_file_risks", {
  itemId: uuid("item_id").primaryKey().references(() => driveItems.id, { onDelete: "cascade" }),
  level: text("level", { enum: ["low", "medium", "high"] }).notNull(),
  /** Jev's risk score from 0 (benign) to 3 (very likely malicious); null when only local signals were used. */
  score: real("score"),
  disguisedProbability: real("disguised_probability"),
  signals: text("signals").array().notNull().default([]),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DriveFileRiskRow = typeof driveFileRisks.$inferSelect;
