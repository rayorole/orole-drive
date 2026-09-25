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
  trashedAt: string | null;
  hasPassword: boolean;
  isLocked: boolean;
  isProtected: boolean;
  tags: string[];
  description: string;
  folderColor: string | null;
  isFavorite: boolean;
};
export const FOLDER_COLORS = ["blue", "green", "amber", "red", "violet", "gray"] as const;
export type DriveFolderColor = (typeof FOLDER_COLORS)[number];
export type DriveListing = {
  items: DriveItem[];
  breadcrumbs: { id: string; name: string }[];
  totalBytes: number;
  totalFiles: number;
  currentFolder: DriveItem | null;
};
export type DriveFilter = "all" | "public" | "recent" | "trash" | "favorites";
export type DriveTypeFilter = "all" | "folder" | "image" | "video" | "audio" | "pdf" | "text" | "code" | "archive" | "other";
export type DriveSort = "name" | "updatedAt" | "size" | "type";
export type DriveListInput = {
  folderId?: string | null;
  filter?: DriveFilter;
  search?: string;
  type?: DriveTypeFilter;
  minSize?: number;
  maxSize?: number;
  after?: string;
  before?: string;
  sort?: DriveSort;
  direction?: "asc" | "desc";
  foldersOnly?: boolean;
  tags?: string[];
};
export type LockedFolder = { id: string; name: string };
export type ActionResult<T> = { success: true; data: T } | { success: false; error: string; lockedFolder?: LockedFolder };
export type DriveArchiveItem = Pick<DriveItem, "id" | "parentId" | "name" | "kind" | "size">;
export type DriveArchiveManifest = { rootIds: string[]; items: DriveArchiveItem[] };
export type DriveRestoreResult = { restoredToRoot: number };
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;
export type UploadTicket =
  | { mode: "single"; id: string; url: string; headers: Record<string, string> }
  | { mode: "multipart"; id: string; partSize: number; parts: { partNumber: number; url: string }[] };
