import "server-only";

import { cache } from "react";
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DriveTransaction } from "@/lib/drive-access";
import { canAccessPublic, withDriveTransaction } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import type { DriveRow } from "@/lib/drive-schema";
import { driveItems } from "@/lib/drive-schema";
import type { DriveArchiveManifest, PublicFolderView, PublicShareCrumb, PublicShareItem } from "@/lib/drive-types";
import { signDownload } from "@/lib/storage";

const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const idSchema = z.uuid();
/** Items listed per folder; the page says when a folder holds more. */
export const PUBLIC_FOLDER_PAGE_SIZE = 1000;
/** Files and folders one "Download all" ZIP may contain. */
const PUBLIC_ARCHIVE_MAX_ITEMS = 20_000;

export type PublicFileAccess = { item: PublicShareItem; downloadUrl: string; previewUrl: string | null; sharedByEmail: string | null };
export type PublicShare = ({ kind: "file" } & PublicFileAccess) | { kind: "folder"; name: string };

function publicItem(row: Pick<DriveRow, "id" | "name" | "kind" | "size" | "mimeType" | "updatedAt" | "folderColor" | "folderEmoji">): PublicShareItem {
  return { id: row.id, name: row.name, kind: row.kind, size: row.size, mimeType: row.mimeType, updatedAt: row.updatedAt.toISOString(), folderColor: row.folderColor, folderEmoji: row.folderEmoji };
}

/** The shared item behind an active token, share-locked so revocation cannot interleave with signing. */
async function loadShare(tx: DriveTransaction, token: string): Promise<DriveRow | null> {
  if (!PUBLIC_TOKEN_PATTERN.test(token)) return null;
  const [row] = await tx.select().from(driveItems).where(and(
    eq(driveItems.publicToken, token),
    eq(driveItems.state, "complete"),
    sql`(${driveItems.publicExpiresAt} is null or ${driveItems.publicExpiresAt} > clock_timestamp())`,
  )).limit(1).for("share");
  return row && await canAccessPublic(tx, row) ? row : null;
}

/** Signed URLs never outlive the share's own expiry. */
async function signFile(row: DriveRow, share: DriveRow): Promise<{ downloadUrl: string; previewUrl: string | null } | null> {
  const expiresIn = share.publicExpiresAt ? (share.publicExpiresAt.getTime() - Date.now()) / 1000 : undefined;
  const [downloadUrl, previewUrl] = await Promise.all([signDownload(row, false, expiresIn), signDownload(row, true, expiresIn)]);
  return downloadUrl ? { downloadUrl, previewUrl } : null;
}

/**
 * The folders from the shared folder down to `folderId`, or null when that folder is outside the share,
 * unavailable, or is (or sits inside) a password-protected folder. Nothing above the shared folder is read out.
 */
async function sharedFolderPath(tx: DriveTransaction, share: DriveRow, folderId: string): Promise<PublicShareCrumb[] | null> {
  if (folderId === share.id) return [{ id: share.id, name: share.name, folderColor: share.folderColor, folderEmoji: share.folderEmoji }];
  const chain = await tx.execute<{ id: string; name: string; kind: string; state: string; trashed: boolean; deleting: boolean; has_password: boolean; access_mode: string; owner_id: string | null; folderColor: string | null; folderEmoji: string | null }>(sql`
    with recursive chain as (
      select item.id, item.parent_id, item.name, item.kind, item.state,
        item.trashed_at is not null as trashed, item.deletion_started_at is not null as deleting,
        item.password_hash is not null as has_password, item.access_mode, item.owner_id, item.folder_color, item.folder_emoji, 0 as depth
      from drive_items item where item.id = ${folderId}::uuid
      union all
      select parent.id, parent.parent_id, parent.name, parent.kind, parent.state,
        parent.trashed_at is not null, parent.deletion_started_at is not null,
        parent.password_hash is not null, parent.access_mode, parent.owner_id, parent.folder_color, parent.folder_emoji, chain.depth + 1
      from drive_items parent join chain on parent.id = chain.parent_id
      where chain.id <> ${share.id}::uuid and chain.depth < 64
    ) select id, name, kind, state, trashed, deleting, has_password, access_mode, owner_id, folder_color as "folderColor", folder_emoji as "folderEmoji" from chain order by depth desc
  `);
  if (chain[0]?.id !== share.id) return null;
  if (chain.some((node) => node.kind !== "folder" || node.state !== "complete" || node.trashed || node.deleting || node.has_password || !node.owner_id || (node.id !== share.id && node.access_mode !== "inherit"))) return null;
  return chain.map(({ id, name, folderColor, folderEmoji }) => ({ id, name, folderColor, folderEmoji }));
}

/** Resolves a token for the share page; memoized per request so metadata and page share one lookup. */
export const getPublicShare = cache((token: string): Promise<PublicShare | null> => withDriveTransaction("read", async (tx) => {
  const share = await loadShare(tx, token);
  if (!share) return null;
  if (share.kind === "folder") return { kind: "folder", name: share.name };
  const urls = await signFile(share, share);
  return urls && { kind: "file", item: publicItem(share), ...urls, sharedByEmail: share.sharedByEmail };
}));

/** Lists one folder of a folder share: the shared folder itself when `folderId` is null. */
export async function getPublicFolderView(token: string, folderId: string | null): Promise<PublicFolderView | null> {
  if (folderId !== null && !idSchema.safeParse(folderId).success) return null;
  return withDriveTransaction("read", async (tx) => {
    const share = await loadShare(tx, token);
    if (share?.kind !== "folder") return null;
    const breadcrumbs = await sharedFolderPath(tx, share, folderId ?? share.id);
    if (!breadcrumbs) return null;
    const rows = await tx.select({
      id: driveItems.id, name: driveItems.name, kind: driveItems.kind, size: driveItems.size,
      mimeType: driveItems.mimeType, updatedAt: driveItems.updatedAt, folderColor: driveItems.folderColor, folderEmoji: driveItems.folderEmoji,
    }).from(driveItems).where(and(
      eq(driveItems.parentId, breadcrumbs[breadcrumbs.length - 1].id),
      eq(driveItems.state, "complete"),
      isNull(driveItems.trashedAt),
      isNull(driveItems.deletionStartedAt),
      eq(driveItems.accessMode, "inherit"),
      isNotNull(driveItems.ownerId),
      // Protected subfolders stay invisible, not just locked: their names are private too.
      or(eq(driveItems.kind, "file"), isNull(driveItems.passwordHash)),
    )).orderBy(desc(driveItems.kind), asc(sql`lower(${driveItems.name})`), asc(driveItems.id)).limit(PUBLIC_FOLDER_PAGE_SIZE + 1);
    return {
      share: { sharedByEmail: share.sharedByEmail, expiresAt: share.publicExpiresAt?.toISOString() ?? null },
      breadcrumbs,
      items: rows.slice(0, PUBLIC_FOLDER_PAGE_SIZE).map(publicItem),
      truncated: rows.length > PUBLIC_FOLDER_PAGE_SIZE,
    };
  });
}

/** A file anywhere inside a folder share, with short-lived URLs, re-validated on every call. */
export async function getPublicFolderFile(token: string, fileId: string): Promise<(PublicFileAccess & { breadcrumbs: PublicShareCrumb[] }) | null> {
  if (!idSchema.safeParse(fileId).success) return null;
  return withDriveTransaction("read", async (tx) => {
    const share = await loadShare(tx, token);
    if (share?.kind !== "folder") return null;
    const [row] = await tx.select().from(driveItems).where(and(
      eq(driveItems.id, fileId),
      eq(driveItems.kind, "file"),
      eq(driveItems.state, "complete"),
      isNull(driveItems.trashedAt),
      isNull(driveItems.deletionStartedAt),
      eq(driveItems.accessMode, "inherit"),
      isNotNull(driveItems.ownerId),
    )).limit(1).for("share");
    if (!row?.parentId) return null;
    const breadcrumbs = await sharedFolderPath(tx, share, row.parentId);
    if (!breadcrumbs) return null;
    const urls = await signFile(row, share);
    return urls && { item: publicItem(row), ...urls, sharedByEmail: share.sharedByEmail, breadcrumbs };
  });
}

/** Everything visible below one folder of a folder share, shaped for the browser's ZIP writer. */
export async function getPublicFolderManifest(token: string, folderId: string): Promise<DriveArchiveManifest | null> {
  if (!idSchema.safeParse(folderId).success) return null;
  return withDriveTransaction("read", async (tx) => {
    const share = await loadShare(tx, token);
    if (share?.kind !== "folder" || !(await sharedFolderPath(tx, share, folderId))) return null;
    const rows = await tx.execute<{ id: string; parentId: string | null; name: string; kind: "file" | "folder"; size: string | number }>(sql`
      with recursive tree as (
        select item.id, item.parent_id, item.name, item.kind, item.size, 0 as depth
        from drive_items item where item.id = ${folderId}::uuid
        union all
        select child.id, child.parent_id, child.name, child.kind, child.size, tree.depth + 1
        from drive_items child join tree on child.parent_id = tree.id
        where tree.kind = 'folder' and tree.depth < 64
          and child.state = 'complete' and child.trashed_at is null and child.deletion_started_at is null
          and child.access_mode = 'inherit' and child.owner_id is not null
          and (child.kind = 'file' or child.password_hash is null)
      ) select id, parent_id as "parentId", name, kind, size from tree limit ${PUBLIC_ARCHIVE_MAX_ITEMS + 1}
    `);
    if (rows.length > PUBLIC_ARCHIVE_MAX_ITEMS) {
      throw new DriveError(`This folder holds more than ${PUBLIC_ARCHIVE_MAX_ITEMS.toLocaleString("en")} items. Open a subfolder and download that instead.`);
    }
    // The ZIP root is the folder being downloaded; its real parent stays private.
    return {
      rootIds: [folderId],
      items: rows.map((row) => ({ id: row.id, parentId: row.id === folderId ? null : row.parentId, name: row.name, kind: row.kind, size: Number(row.size) })),
    };
  });
}
