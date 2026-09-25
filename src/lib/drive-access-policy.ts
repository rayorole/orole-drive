import { DriveError, LockedFolderError } from "./drive-errors";
import type { DriveAccessMode, DrivePermission, ShareMember } from "./drive-types";

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
  ownerId: string | null;
  owner: ShareMember | null;
  accessMode: DriveAccessMode;
  memberRole: "viewer" | "editor";
  selectedRole: "viewer" | "editor" | null;
}

export interface DriveAccessFlags {
  hasPassword: boolean;
  isLocked: boolean;
  isProtected: boolean;
  owner: ShareMember | null;
  permission: DrivePermission;
  /** An inaccessible parent must not be disclosed or used as a navigation target. */
  parentId: string | null;
}

export interface DriveAccessOptions {
  allowTrashed?: boolean;
  includeSelf?: boolean;
  permission?: "read" | "write" | "manage";
}

function itemPath(nodes: ReadonlyMap<string, DriveAccessNode>, id: string): DriveAccessNode[] {
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
  if (!path[0] || (path[0].kind === "folder" && path.length > 64)) {
    throw new DriveError("This folder path is too deep or is unavailable.");
  }
  return path;
}

function itemPermission(path: readonly DriveAccessNode[], userId: string, start = 0): DrivePermission | null {
  for (let index = start; index < path.length; index += 1) {
    const node = path[index];
    if (!node.ownerId) return null;
    if (node.ownerId === userId) return index === start ? "owner" : "editor";
    if (node.accessMode === "members") return node.memberRole;
    if (node.accessMode === "selected") return node.selectedRole;
    if (node.accessMode === "private") return null;
  }
  return null;
}

export function evaluateItemAccess(
  nodes: ReadonlyMap<string, DriveAccessNode>,
  id: string,
  userId: string,
  options: DriveAccessOptions = {},
): DriveAccessFlags {
  const path = itemPath(nodes, id);
  const item = path[0];
  const permission = itemPermission(path, userId);
  if (!permission || (options.permission === "write" && permission === "viewer") || (options.permission === "manage" && permission !== "owner")) {
    throw new DriveError("You do not have permission to access this item.");
  }
  let isProtected = false;
  // Check outermost first, and never disclose an ACL-inaccessible password ancestor.
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const node = path[index];
    if (!options.allowTrashed && (node.trashed || node.deleting)) {
      throw new DriveError("This item is in Trash or is no longer available.");
    }
    if (node.hasPassword) {
      isProtected = true;
      if (!node.unlocked && !(index === 0 && options.includeSelf === false)) {
        if (!itemPermission(path, userId, index)) throw new DriveError("This item is inside an unavailable protected folder.");
        throw new LockedFolderError(node);
      }
    }
  }
  return {
    hasPassword: item.hasPassword,
    isLocked: item.hasPassword && !item.unlocked,
    isProtected,
    owner: item.owner,
    permission,
    parentId: path.length > 1 && itemPermission(path, userId, 1) ? item.parentId : null,
  };
}

/** A token authorizes its root independently of member ACLs; only inherit children join that public subtree. */
export function evaluatePublicItemAccess(nodes: ReadonlyMap<string, DriveAccessNode>, id: string, shareRootId = id): void {
  const path = itemPath(nodes, id);
  const rootIndex = path.findIndex((node) => node.id === shareRootId);
  if (rootIndex < 0 || !path[0].ownerId || path[0].state !== "complete") throw new DriveError("This public link is unavailable.");
  for (let index = 0; index < path.length; index += 1) {
    const node = path[index];
    if (node.trashed || node.deleting || node.hasPassword || (index < rootIndex && (node.accessMode !== "inherit" || !node.ownerId))) {
      throw new DriveError("This public link is unavailable.");
    }
  }
}
