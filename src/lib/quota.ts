import "server-only";

import type { DriveContext } from "@/lib/drive-access";
import type { DriveTransaction } from "@/lib/db";
import type { StorageQuota } from "@/lib/drive-types";
import { sql } from "drizzle-orm";
import { DriveError } from "@/lib/drive-errors";
import { formatBytes } from "@/lib/format-bytes";

const GiB = 1024 ** 3;
const DEFAULT_STORAGE_QUOTA_BYTES = 1024 * GiB;
const DEFAULT_MEMBER_QUOTA_BYTES = 250 * GiB;

function quotaFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new DriveError("Storage limits are not configured correctly. Please contact the drive administrator.");
  return value;
}

/** Whole-drive limit, `DRIVE_STORAGE_QUOTA_BYTES` (default 1 TiB). */
export function storageQuotaBytes(): number {
  return quotaFromEnv("DRIVE_STORAGE_QUOTA_BYTES", DEFAULT_STORAGE_QUOTA_BYTES);
}

/** Per-member limit on what they uploaded, created or copied, `DRIVE_MEMBER_QUOTA_BYTES` (default 250 GiB). */
export function memberQuotaBytes(): number {
  return quotaFromEnv("DRIVE_MEMBER_QUOTA_BYTES", DEFAULT_MEMBER_QUOTA_BYTES);
}

/**
 * Bytes held in storage: current file contents (including Trash and uploads still in progress, which
 * reserve their size up front) plus kept versions. Member usage counts what that member added;
 * items from before ownership was tracked count only toward the drive total.
 */
export async function storageUsage(tx: DriveTransaction, userId: string): Promise<StorageQuota> {
  const [row] = await tx.execute<{ used: string; member_used: string }>(sql`
    select
      (select coalesce(sum(size), 0) from drive_items where kind = 'file')
        + (select coalesce(sum(size), 0) from drive_file_versions) as used,
      (select coalesce(sum(size), 0) from drive_items where kind = 'file' and created_by = ${userId})
        + (select coalesce(sum(size), 0) from drive_file_versions where created_by = ${userId}) as member_used
  `);
  return {
    usedBytes: Number(row.used), quotaBytes: storageQuotaBytes(),
    memberUsedBytes: Number(row.member_used), memberQuotaBytes: memberQuotaBytes(),
  };
}

/**
 * Rejects adding `bytes` when it would exceed the drive or the member's limit. Call inside the write
 * transaction that reserves the bytes; the drive's advisory write lock serializes concurrent reservations.
 */
export async function assertQuota(tx: DriveTransaction, ctx: DriveContext, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  const usage = await storageUsage(tx, ctx.userId);
  if (usage.usedBytes + bytes > usage.quotaBytes) {
    throw new DriveError(`The drive is full: ${formatBytes(Math.max(0, usage.quotaBytes - usage.usedBytes))} of ${formatBytes(usage.quotaBytes)} left, ${formatBytes(bytes)} needed. Empty Trash or delete old versions to make room.`);
  }
  if (usage.memberUsedBytes + bytes > usage.memberQuotaBytes) {
    throw new DriveError(`You’ve reached your storage limit: ${formatBytes(Math.max(0, usage.memberQuotaBytes - usage.memberUsedBytes))} of ${formatBytes(usage.memberQuotaBytes)} left, ${formatBytes(bytes)} needed. Empty Trash or delete old versions to make room.`);
  }
}
