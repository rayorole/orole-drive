import type { DrivePermission } from "@/lib/drive-types";

/** UI affordances only; server actions recheck current authorization. */
export function canEditItem(item: { permission: DrivePermission } | null | undefined) {
  return item?.permission === "owner" || item?.permission === "editor";
}

export function canManageItem(item: { permission: DrivePermission } | null | undefined) {
  return item?.permission === "owner";
}

export const permissionLabel: Record<DrivePermission, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };
