"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { moveItems, renameItem, restoreItems, trashItems } from "@/app/actions/drive";
import type { ActionResult, ConflictResolutions, DriveCopyResult, DriveMoveResult } from "@/lib/drive-types";
import { DriveAccessError, useFolderAccess } from "@/components/folder-access";
import { useNameConflicts, type ConflictOperation } from "@/components/name-conflicts";

/** An action stays undoable with Ctrl/Cmd+Z as long as its toast shows; the toast's Undo button keeps working while it's on screen. */
const UNDO_MS = 10_000;
const MAX_UNDO = 10;

export type UndoableChange = { kind: "move"; result: DriveMoveResult } | { kind: "trash"; ids: string[] } | { kind: "copy"; result: DriveCopyResult };
type UndoEntry = { id: number; change: UndoableChange; toastId: string | number; expiresAt: number };
type DriveUndo = {
  /** Shows a success toast (replacing toast `id` if given) with an Undo button, and makes the change the latest Ctrl/Cmd+Z target. */
  offerUndo: (message: string, change: UndoableChange, options?: { id?: string | number }) => void;
};

const DriveUndoContext = createContext<DriveUndo | null>(null);
const UNDONE: Record<UndoableChange["kind"], string> = { move: "Moved back", trash: "Restored from Trash", copy: "Copy removed" };

/**
 * Runs a move or copy, asking how to resolve name conflicts and retrying with the answers; null when the
 * user cancels the prompt. `optimistic` is applied for the first attempt only and rolled back as soon as any
 * attempt fails, so items are never shown where a conflict kept them from going.
 */
export function useConflictRun() {
  const { run } = useFolderAccess();
  const { resolveConflicts } = useNameConflicts();
  return useCallback(async <T,>(
    operation: (resolutions: ConflictResolutions) => Promise<ActionResult<T>>,
    options: { operation: ConflictOperation; destinationName: string; optimistic?: () => Promise<() => void> },
  ): Promise<T | null> => {
    let resolutions: ConflictResolutions = {};
    let rollback = await options.optimistic?.();
    for (;;) {
      try {
        return await run(() => operation(resolutions));
      } catch (error) {
        rollback?.();
        rollback = undefined;
        if (!(error instanceof DriveAccessError) || !error.conflicts?.length) throw error;
        const answers = await resolveConflicts(error.conflicts, { operation: options.operation, destinationName: options.destinationName });
        if (!answers) return null;
        resolutions = { ...resolutions, ...answers };
      }
    }
  }, [run, resolveConflicts]);
}

export function DriveUndoProvider({ children }: { children: ReactNode }) {
  const { run } = useFolderAccess();
  const client = useQueryClient();
  const stack = useRef<UndoEntry[]>([]);
  const nextId = useRef(0);
  const undoChange = useCallback(async (change: UndoableChange) => {
    if (change.kind === "trash") {
      await run(() => restoreItems(change.ids));
      return;
    }
    if (change.kind === "copy") {
      if (change.result.ids.length) {
        await run(() => trashItems(change.result.ids));
      }
    } else {
      const byParent = new Map<string | null, string[]>();
      for (const { id, fromParentId } of change.result.moved) byParent.set(fromParentId, [...byParent.get(fromParentId) ?? [], id]);
      // Moving back never asks: anything that took a name in the meantime is kept and the item is numbered instead.
      const numberedBack = new Set<string>();
      for (const [parentId, ids] of byParent) {
        let result: DriveMoveResult;
        try {
          result = await run(() => moveItems({ ids, parentId }));
        } catch (error) {
          if (!(error instanceof DriveAccessError) || !error.conflicts?.length) throw error;
          const resolutions: ConflictResolutions = Object.fromEntries(error.conflicts.map((conflict) => [conflict.id, "keep-both"]));
          result = await run(() => moveItems({ ids, parentId, resolutions }));
        }
        for (const { id } of result.renamed) numberedBack.add(id);
      }
      for (const { id, fromName } of change.result.renamed) if (!numberedBack.has(id)) await run(() => renameItem({ id, name: fromName }));
    }
    if (change.result.replacedIds.length) await run(() => restoreItems(change.result.replacedIds));
  }, [run]);

  const undo = useCallback(async (entryId: number) => {
    const entry = stack.current.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    stack.current = stack.current.filter((candidate) => candidate !== entry);
    toast.dismiss(entry.toastId);
    const toastId = toast.loading("Undoing…");
    try {
      await undoChange(entry.change);
      toast.success(UNDONE[entry.change.kind], { id: toastId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t undo that.", { id: toastId });
    } finally {
      void client.invalidateQueries({ queryKey: ["drive"] });
      void client.invalidateQueries({ queryKey: ["storage-usage"] });
    }
  }, [client, undoChange]);

  const offerUndo = useCallback<DriveUndo["offerUndo"]>((message, change, options) => {
    const id = ++nextId.current;
    const toastId = toast.success(message, { id: options?.id, duration: UNDO_MS, action: { label: "Undo", onClick: () => void undo(id) } });
    stack.current = [...stack.current, { id, change, toastId, expiresAt: Date.now() + UNDO_MS }].slice(-MAX_UNDO);
  }, [undo]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "z") return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=alertdialog], [role=menu]")) return;
      const latest = stack.current.findLast((entry) => entry.expiresAt > Date.now());
      if (!latest) return;
      event.preventDefault();
      void undo(latest.id);
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [undo]);

  const value = useMemo(() => ({ offerUndo }), [offerUndo]);
  return <DriveUndoContext.Provider value={value}>{children}</DriveUndoContext.Provider>;
}

export function useDriveUndo(): DriveUndo {
  const context = useContext(DriveUndoContext);
  if (!context) throw new Error("useDriveUndo must be used inside DriveUndoProvider.");
  return context;
}
