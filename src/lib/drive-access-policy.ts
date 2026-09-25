import { DriveError, LockedFolderError } from "./drive-errors";

export interface DriveAccessNode {
  id: string;
  name: string;
  parentId: string | null;
  kind: "file" | "folder";
  state: "pending" | "complete";
  trashed: boolean;
  deleting: boolean;
  hasPassword: boolean;
  unlocked: boolean;
}

export interface DriveAccessFlags {
  hasPassword: boolean;
  isLocked: boolean;
  isProtected: boolean;
}

export interface DriveAccessOptions {
  allowTrashed?: boolean;
  includeSelf?: boolean;
}

export function evaluateItemAccess(
  nodes: ReadonlyMap<string, DriveAccessNode>,
  id: string,
  options: DriveAccessOptions = {},
): DriveAccessFlags {
  const path: DriveAccessNode[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor) {
    const node = nodes.get(cursor);
    if (!node || seen.has(cursor) || path.length > 64) {
      throw new DriveError("This folder path is too deep or is unavailable.");
    }
    if (path.length && (node.kind !== "folder" || node.state !== "complete")) {
      throw new DriveError("This folder is no longer available.");
    }
    seen.add(cursor);
    path.push(node);
    cursor = node.parentId;
  }
  const item = path[0];
  if (!item || (item.kind === "folder" && path.length > 64)) {
    throw new DriveError("This folder path is too deep or is unavailable.");
  }
  let isProtected = false;
  // Check outermost first: a failed request must not disclose a hidden nested folder's name.
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const node = path[index];
    if (!options.allowTrashed && (node.trashed || node.deleting)) {
      throw new DriveError("This item is in Trash or is no longer available.");
    }
    if (node.hasPassword) {
      isProtected = true;
      if (!node.unlocked && !(index === 0 && options.includeSelf === false)) {
        throw new LockedFolderError(node);
      }
    }
  }
  return {
    hasPassword: item.hasPassword,
    isLocked: item.hasPassword && !item.unlocked,
    isProtected,
  };
}
