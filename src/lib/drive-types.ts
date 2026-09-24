export type DriveItem = {
  id: string;
  name: string;
  kind: "file" | "folder";
  parentId: string | null;
  size: number;
  mimeType: string | null;
  createdAt: string;
  updatedAt: string;
  publicToken: string | null;
};
export type DriveListing = {
  items: DriveItem[];
  breadcrumbs: { id: string; name: string }[];
  totalBytes: number;
  totalFiles: number;
};
export type DriveFilter = "all" | "public" | "recent";
export type ActionResult<T> = { success: true; data: T } | { success: false; error: string };
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
