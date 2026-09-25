"use server";

import type { ActionResult, StorageCategory, StorageUsageReport } from "@/lib/drive-types";
import { and, desc, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { driveAction, tryItemsAccess, visibleItemsCondition, withDriveTransaction } from "@/lib/drive-access";
import { driveItems } from "@/lib/drive-schema";
import { itemType } from "@/lib/item-type";
import { storageUsage } from "@/lib/quota";

const CATEGORIES: StorageCategory[] = ["image", "video", "audio", "pdf", "text", "code", "archive", "other"];
const LARGEST_FILES = 20;

/**
 * Current ACL-visible usage against configured limits, including accessible Trash and pending uploads.
 * Actual quota enforcement also counts private storage that this report must not disclose.
 */
export async function getStorageUsage(): Promise<ActionResult<StorageUsageReport>> {
  return driveAction(async (ctx) => withDriveTransaction("read", async (tx) => {
    const quota = await storageUsage(tx, ctx);
    const readable = visibleItemsCondition(ctx, { trash: true, includePending: true });
    const inTrash = sql`(${driveItems.trashedAt} is not null or ${driveItems.deletionStartedAt} is not null)`;
    const buckets = await tx.select({
      bucket: sql<string>`case when ${driveItems.state} = 'pending' then 'uploading' when ${inTrash} then 'trash' else ${itemType} end`,
      bytes: sql<number>`coalesce(sum(${driveItems.size}), 0)`.mapWith(Number),
      files: sql<number>`count(*)`.mapWith(Number),
    }).from(driveItems).where(and(eq(driveItems.kind, "file"), readable)).groupBy(sql`1`);
    // Versions of trashed files go with them when Trash is emptied, so they count as Trash.
    const [versions] = await tx.execute<{ current_bytes: string; trashed_bytes: string }>(sql`
      select
        coalesce(sum(version.size) filter (where item.trashed_at is null and item.deletion_started_at is null), 0) as current_bytes,
        coalesce(sum(version.size) filter (where item.trashed_at is not null or item.deletion_started_at is not null), 0) as trashed_bytes
      from drive_file_versions version join drive_items item on item.id = version.item_id
      where item.id in (select id from drive_items where ${readable})
    `);
    const members = await tx.execute<{ id: string | null; name: string | null; email: string | null; bytes: string }>(sql`
      with readable_items as (select id, size, created_by from drive_items where kind = 'file' and ${readable})
      select member.id, member.name, member.email, usage.bytes
      from (
        select created_by, sum(size) as bytes from (
          select created_by, size from readable_items
          union all select version.created_by, version.size from drive_file_versions version
            join readable_items item on item.id = version.item_id
        ) added group by created_by having sum(size) > 0
      ) usage left join auth_user member on member.id = usage.created_by
      order by usage.bytes desc, member.email
    `);
    const parent = alias(driveItems, "parent");
    const largest = await tx.select({
      id: driveItems.id, name: driveItems.name, size: driveItems.size, mimeType: driveItems.mimeType,
      trashed: sql<boolean>`${driveItems.trashedAt} is not null`,
      // A trashed file is listed inside its folder in Trash only when they were trashed together.
      folderId: sql<string | null>`case when ${driveItems.trashedAt} is null
        or (${parent.trashedAt} is not null and ${parent.trashRootId} is not distinct from ${driveItems.trashRootId})
        then ${driveItems.parentId} end`,
    }).from(driveItems).leftJoin(parent, eq(parent.id, driveItems.parentId)).where(and(
      eq(driveItems.kind, "file"), eq(driveItems.state, "complete"), isNull(driveItems.deletionStartedAt), gt(driveItems.size, 0),
      visibleItemsCondition(ctx, { trash: true }),
    )).orderBy(desc(driveItems.size), asc(driveItems.id)).limit(LARGEST_FILES);
    const parentIds = [...new Set(largest.flatMap((row) => row.folderId ? [row.folderId] : []))];
    const parentAccess = await tryItemsAccess(tx, ctx, parentIds, { allowTrashed: true, includeSelf: true, permission: "read" });

    const byBucket = new Map(buckets.map((row) => [row.bucket, row]));
    const categories = CATEGORIES.map((category) => ({ category, bytes: byBucket.get(category)?.bytes ?? 0, files: byBucket.get(category)?.files ?? 0 }));
    return {
      ...quota,
      fileCount: categories.reduce((sum, row) => sum + row.files, 0),
      categories,
      trashBytes: (byBucket.get("trash")?.bytes ?? 0) + Number(versions.trashed_bytes),
      versionBytes: Number(versions.current_bytes),
      uploadingBytes: byBucket.get("uploading")?.bytes ?? 0,
      members: members.map((row) => ({ id: row.id, name: row.name, email: row.email, bytes: Number(row.bytes), isYou: row.id === ctx.userId })),
      largestFiles: largest.map((row) => ({ ...row, folderId: row.folderId && parentAccess.get(row.folderId) ? row.folderId : null })),
    };
  }), "read");
}
