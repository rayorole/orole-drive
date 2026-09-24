"use server";

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, ilike, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { FamilyAuthError, requireFamily } from "@/lib/auth";
import { getDb, type Database, type DriveTransaction as Transaction } from "@/lib/db";
import { driveItems } from "@/lib/drive-schema";
import {
  MAX_UPLOAD_BYTES,
  type ActionResult,
  type DriveFilter,
  type DriveItem,
  type DriveListing,
} from "@/lib/drive-types";
import {
  commitUpload,
  createObjectKey,
  createPublicToken,
  DriveError,
  pruneExpiredUploads,
  publicShareUrl,
  removeObject,
  removeStagedObject,
  signDownload,
  signUpload,
  toDriveItem,
} from "@/lib/storage";

const idSchema = z.uuid("Choose a valid file or folder.");
const parentSchema = idSchema.nullable().optional().transform((id) => id ?? null);
const nameSchema = z.string().trim().normalize().min(1, "Enter a name.").max(255, "Names must be 255 characters or fewer.").refine(
  (name) => name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") &&
    !/[\p{Cc}\p{Bidi_Control}]/u.test(name) && name.isWellFormed() && Buffer.byteLength(name, "utf8") <= 255,
  "Use a name without slashes or control characters, up to 255 bytes long.",
);
const mimeSchema = z.string().trim().toLowerCase().max(127).regex(
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/,
  "Choose a file with a valid content type.",
);

async function familyAction<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireFamily();
    return { success: true, data: await work() };
  } catch (error) {
    if (error instanceof DriveError || error instanceof FamilyAuthError) {
      return { success: false, error: error.message };
    }
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? "Check the information and try again." };
    }
    return { success: false, error: "The drive could not complete that request. Please try again." };
  }
}

async function folderTrail(db: Database | Transaction, folderId: string | null) {
  const breadcrumbs: DriveListing["breadcrumbs"] = [];
  const seen = new Set<string>();
  let cursor = folderId;
  while (cursor) {
    if (seen.has(cursor) || breadcrumbs.length >= 64) {
      throw new DriveError("This folder path is too deep or is unavailable.");
    }
    seen.add(cursor);
    const [folder] = await db.select({ id: driveItems.id, name: driveItems.name, parentId: driveItems.parentId })
      .from(driveItems).where(and(
        eq(driveItems.id, cursor), eq(driveItems.kind, "folder"), eq(driveItems.state, "complete"),
      )).limit(1);
    if (!folder) throw new DriveError("This folder is no longer available.");
    breadcrumbs.push({ id: folder.id, name: folder.name });
    cursor = folder.parentId;
  }
  return breadcrumbs.reverse();
}

async function lockParent(tx: Transaction, parentId: string | null, addingFolder = false) {
  if (!parentId) return;
  // A matching lock in deletion prevents a child being inserted into a disappearing folder.
  const [parent] = await tx.select({ id: driveItems.id }).from(driveItems).where(and(
    eq(driveItems.id, parentId), eq(driveItems.kind, "folder"), eq(driveItems.state, "complete"),
  )).for("update");
  if (!parent) throw new DriveError("The destination folder is no longer available.");
  const trail = await folderTrail(tx, parentId);
  if (addingFolder && trail.length >= 64) throw new DriveError("Folders can be nested up to 64 levels deep.");
}

export async function listDrive(input: {
  folderId?: string | null;
  filter?: DriveFilter;
  search?: string;
} = {}): Promise<ActionResult<DriveListing>> {
  return familyAction(async () => {
    const { folderId, filter, search } = z.object({
      folderId: parentSchema,
      filter: z.enum(["all", "public", "recent"]).default("all"),
      search: z.string().trim().max(200, "Search must be 200 characters or fewer.").default(""),
    }).parse(input);
    await pruneExpiredUploads();
    return getDb().transaction(async (tx) => {
      const breadcrumbs = await folderTrail(tx, folderId);
      const conditions: SQL[] = [eq(driveItems.state, "complete")];
      if (filter === "public") conditions.push(eq(driveItems.kind, "file"), isNotNull(driveItems.publicToken));
      if (filter === "recent") conditions.push(eq(driveItems.kind, "file"));
      if (search) {
        const escapedSearch = search.replace(/[\\%_]/g, "\\$&");
        conditions.push(ilike(driveItems.name, `%${escapedSearch}%`));
      }
      if (filter === "all" && !search) {
        conditions.push(folderId ? eq(driveItems.parentId, folderId) : isNull(driveItems.parentId));
      } else if (folderId) {
        // Search and filtered views include descendants, not unrelated family folders.
        conditions.push(sql`${driveItems.parentId} in (
          with recursive descendants as (
            select id, 1 as depth from drive_items where id = ${folderId}::uuid
            union all
            select child.id, descendants.depth + 1 from drive_items child
            join descendants on child.parent_id = descendants.id
            where child.kind = 'folder' and child.state = 'complete' and descendants.depth < 64
          ) select id from descendants
        )`);
      }
      const query = tx.select().from(driveItems).where(and(...conditions));
      const rows = filter === "recent"
        ? await query.orderBy(desc(driveItems.updatedAt), asc(driveItems.id)).limit(100)
        : await query.orderBy(desc(driveItems.kind), asc(driveItems.name), asc(driveItems.id));
      const [totals] = await tx.select({
        totalBytes: sql<number>`coalesce(sum(${driveItems.size}), 0)`.mapWith(Number),
        totalFiles: count(),
      }).from(driveItems).where(and(eq(driveItems.state, "complete"), eq(driveItems.kind, "file")));
      return { items: rows.map(toDriveItem), breadcrumbs, totalBytes: totals.totalBytes, totalFiles: totals.totalFiles };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  });
}

export async function createFolder(input: { name: string; parentId?: string | null }): Promise<ActionResult<DriveItem>> {
  return familyAction(async () => {
    const { name, parentId } = z.object({ name: nameSchema, parentId: parentSchema }).parse(input);
    return getDb().transaction(async (tx) => {
      await lockParent(tx, parentId, true);
      const [folder] = await tx.insert(driveItems).values({
        id: randomUUID(), name, parentId, kind: "folder", state: "complete", size: 0,
      }).returning();
      return toDriveItem(folder);
    });
  });
}

export async function beginUpload(input: {
  name: string;
  size: number;
  mimeType: string;
  parentId?: string | null;
}): Promise<ActionResult<{ id: string; url: string; headers: Record<string, string> }>> {
  return familyAction(async () => {
    const { name, size, mimeType, parentId } = z.object({
      name: nameSchema,
      size: z.number().int().min(0).max(MAX_UPLOAD_BYTES, "Files must be 5 GiB or smaller."),
      mimeType: mimeSchema,
      parentId: parentSchema,
    }).parse(input);
    await pruneExpiredUploads();
    return getDb().transaction(async (tx) => {
      await lockParent(tx, parentId);
      const id = randomUUID();
      const [row] = await tx.insert(driveItems).values({
        id, name, size, mimeType, parentId, kind: "file", state: "pending", objectKey: createObjectKey(id),
      }).returning();
      return signUpload(row);
    });
  });
}

export async function completeUpload(id: string): Promise<ActionResult<DriveItem>> {
  return familyAction(async () => {
    id = idSchema.parse(id);
    const completed = await getDb().transaction(async (tx) => {
      // Completion and deletion serialize on this row; neither can resurrect a deleted file.
      const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id)).for("update");
      if (!row || row.kind !== "file") throw new DriveError("This upload is no longer available.");
      if (row.state === "complete") return row;
      const etag = await commitUpload(row);
      const [completed] = await tx.update(driveItems).set({ state: "complete", etag, updatedAt: new Date() })
        .where(eq(driveItems.id, id)).returning();
      return completed;
    });
    // Cleanup is not part of committing the file. The uploads/ lifecycle is its backstop.
    await removeStagedObject(completed).catch(() => undefined);
    return toDriveItem(completed);
  });
}

async function removeItem(id: string, pendingOnly: boolean) {
  id = idSchema.parse(id);
  await getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id)).for("update");
    if (!row) return;
    if (pendingOnly && (row.kind !== "file" || row.state !== "pending")) {
      throw new DriveError("This upload has already completed. Use Delete to remove the file.");
    }
    if (row.kind === "folder") {
      const children = await tx.select().from(driveItems).where(eq(driveItems.parentId, id)).for("update");
      if (children.some((child) => child.state === "complete")) {
        throw new DriveError("This folder contains files or subfolders. Remove them before deleting the folder.");
      }
      for (const child of children) {
        await removeObject(child);
        await tx.delete(driveItems).where(eq(driveItems.id, child.id));
      }
    } else {
      await removeObject(row);
    }
    await tx.delete(driveItems).where(eq(driveItems.id, id));
  });
}

export async function cancelUpload(id: string): Promise<ActionResult<void>> {
  return familyAction(() => removeItem(id, true));
}

export async function deleteItem(id: string): Promise<ActionResult<void>> {
  return familyAction(() => removeItem(id, false));
}

export async function renameItem(input: { id: string; name: string }): Promise<ActionResult<void>> {
  return familyAction(async () => {
    const { id, name } = z.object({ id: idSchema, name: nameSchema }).parse(input);
    const [renamed] = await getDb().update(driveItems).set({ name, updatedAt: new Date() })
      .where(and(eq(driveItems.id, id), eq(driveItems.state, "complete"))).returning({ id: driveItems.id });
    if (!renamed) throw new DriveError("This file or folder is no longer available.");
  });
}

export async function setPublic(input: { id: string; enabled: boolean }): Promise<ActionResult<{ url: string | null }>> {
  return familyAction(async () => {
    const { id, enabled } = z.object({ id: idSchema, enabled: z.boolean() }).parse(input);
    return getDb().transaction(async (tx) => {
      const [row] = await tx.select().from(driveItems).where(and(
        eq(driveItems.id, id), eq(driveItems.state, "complete"),
      )).for("update");
      if (!row) throw new DriveError("This file is no longer available.");
      if (row.kind !== "file") throw new DriveError("Only files can have public links. Share the files inside this folder instead.");
      const publicToken = enabled ? row.publicToken ?? createPublicToken() : null;
      const url = publicToken ? publicShareUrl(publicToken) : null;
      await tx.update(driveItems).set({ publicToken, updatedAt: new Date() }).where(eq(driveItems.id, id));
      return { url };
    });
  });
}

export async function getDownloadUrl(id: string): Promise<ActionResult<{ url: string }>> {
  return familyAction(async () => {
    id = idSchema.parse(id);
    return getDb().transaction(async (tx) => {
      const [row] = await tx.select().from(driveItems).where(and(
        eq(driveItems.id, id), eq(driveItems.kind, "file"), eq(driveItems.state, "complete"),
      )).for("share");
      if (!row) throw new DriveError("This file is no longer available.");
      const url = await signDownload(row);
      if (!url) throw new DriveError("This file is not available for download.");
      return { url };
    });
  });
}

export async function getPreviewUrl(id: string): Promise<ActionResult<{ url: string | null }>> {
  return familyAction(async () => {
    id = idSchema.parse(id);
    return getDb().transaction(async (tx) => {
      const [row] = await tx.select().from(driveItems).where(and(
        eq(driveItems.id, id), eq(driveItems.kind, "file"), eq(driveItems.state, "complete"),
      )).for("share");
      if (!row) throw new DriveError("This file is no longer available.");
      return { url: await signDownload(row, true) };
    });
  });
}
