import type { ConflictResolutions } from "./drive-types";
import type { DestinationSibling } from "./name-conflicts";
import { copyName, numberedName } from "./copy-name";
import { findConflicts, resolveConflicts } from "./name-conflicts";

export type TransferRoot = { id: string; name: string; kind: "file" | "folder"; parentId: string | null };

export type TransferPlan<T extends TransferRoot> = {
  /** Roots that go ahead, in selection order, with their final name in the destination. */
  items: { root: T; name: string }[];
  /** Destination items the user chose to replace; they go to Trash so the incoming item can take the name. */
  replaceIds: string[];
};

/**
 * Decides what a move or copy of `roots` into `parentId` does, given the destination's current items.
 * Throws NameConflictError for collisions with destination items that `resolutions` doesn't answer yet.
 * - Moves: roots already in the destination stay where they are and aren't part of the plan.
 * - Copies into the folder the item already lives in duplicate it in place as "name (copy)", never asked about.
 * - Two incoming roots with the same name (e.g. picked from different folders in search results) are not
 *   asked about: the first keeps its name, later ones are numbered like Keep both. Roots keeping their own
 *   name claim it before any numbered name is handed out, so a numbered name never pushes them aside.
 */
export function planTransfer<T extends TransferRoot>(
  roots: T[], siblings: Map<string, DestinationSibling>, resolutions: ConflictResolutions, mode: "move" | "copy", parentId: string | null,
): TransferPlan<T> {
  const incoming = mode === "move" ? roots.filter((root) => root.parentId !== parentId) : roots;
  const inPlace = new Set(mode === "copy" ? roots.filter((root) => root.parentId === parentId).map((root) => root.id) : []);
  const decisions = resolveConflicts(findConflicts(incoming.filter((root) => !inPlace.has(root.id)), siblings), resolutions);
  const replaceIds = new Set([...decisions.values()].filter(({ resolution }) => resolution === "replace").map(({ conflict }) => conflict.existingId));
  const remaining = [...siblings.values()].filter((sibling) => !replaceIds.has(sibling.id));
  const exact = new Set(remaining.map((sibling) => sibling.name));
  const lower = new Set(remaining.map((sibling) => sibling.name.toLowerCase()));
  const take = (name: string) => { exact.add(name); lower.add(name.toLowerCase()); return name; };
  const names = new Map<string, string>();
  const going = incoming.filter((root) => decisions.get(root.id)?.resolution !== "skip");
  for (const root of going) {
    const resolution = decisions.get(root.id)?.resolution;
    if (!inPlace.has(root.id) && resolution !== "keep-both" && !lower.has(root.name.toLowerCase())) names.set(root.id, take(root.name));
  }
  for (const root of going) {
    if (names.has(root.id)) continue;
    names.set(root.id, take(inPlace.has(root.id) ? copyName(root.name, root.kind, exact) : numberedName(root.name, root.kind, lower)));
  }
  return { items: going.map((root) => ({ root, name: names.get(root.id)! })), replaceIds: [...replaceIds] };
}
