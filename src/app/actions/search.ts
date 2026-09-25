"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordEvents } from "@/lib/activity";
import { assertItemAccess, driveAction, withDriveTransaction } from "@/lib/drive-access";
import { idSchema } from "@/lib/drive-input";
import { DriveError } from "@/lib/drive-errors";
import { driveItems } from "@/lib/drive-schema";
import type { ActionResult, SearchIndexStatus } from "@/lib/drive-types";
import { isSearchConfigured } from "@/lib/search-config";
import { enqueueSearchTree, removeFromSearch } from "@/lib/search-index";
import { driveSearchDocs } from "@/lib/search-schema";

/** Owner-only: a folder and everything inside it leave AI search (or come back) immediately. */
export async function setSearchExcluded(input: { id: string; excluded: boolean }): Promise<ActionResult<void>> {
  return driveAction(async (ctx) => {
    const { id, excluded } = z.object({ id: idSchema, excluded: z.boolean() }).parse(input);
    await withDriveTransaction("write", async (tx) => {
      const [folder] = await tx.select().from(driveItems).where(and(eq(driveItems.id, id), eq(driveItems.kind, "folder"), eq(driveItems.state, "complete"))).for("update");
      if (!folder) throw new DriveError("This folder is no longer available.");
      await assertItemAccess(tx, ctx, folder, { permission: "manage" });
      if (folder.searchExcluded === excluded) return;
      await tx.update(driveItems).set({ searchExcluded: excluded }).where(eq(driveItems.id, id));
      if (excluded) await removeFromSearch(tx, [id], "excluded");
      else await enqueueSearchTree(tx, [id]);
      await recordEvents(tx, ctx, [{ action: excluded ? "exclude_search" : "include_search", item: { id, name: folder.name, kind: "folder", parentId: folder.parentId } }]);
    });
  });
}

/** Where a readable file stands in the search index; null when search is not configured. */
export async function getSearchStatus(id: string): Promise<ActionResult<SearchIndexStatus | null>> {
  return driveAction(async (ctx) => {
    const itemId = idSchema.parse(id);
    return withDriveTransaction("read", async (tx) => {
      const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, itemId));
      if (!row || row.kind !== "file" || row.state !== "complete") throw new DriveError("This file is no longer available.");
      await assertItemAccess(tx, ctx, row, { permission: "read", allowTrashed: true });
      if (!isSearchConfigured()) return null;
      const [doc] = await tx.select({ status: driveSearchDocs.status, skipReason: driveSearchDocs.skipReason }).from(driveSearchDocs).where(eq(driveSearchDocs.itemId, itemId));
      return doc ? { state: doc.status, skipReason: doc.skipReason } : { state: "not_indexed", skipReason: null };
    });
  }, "read");
}
