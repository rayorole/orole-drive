import type { DRIVE_EVENT_ACTIONS } from "@/lib/drive-schema";

export type DrivePermission = "owner" | "editor" | "viewer";
export type DriveAccessMode = "private" | "inherit" | "members" | "selected";
export type ShareMember = { id: string; name: string; email: string };
export type DriveSharingStatus = {
  public: "direct" | "inherited" | null;
  members: "all" | "selected" | null;
  membersInherited: boolean;
};
export type ItemSharing = {
  accessMode: DriveAccessMode;
  memberRole: "viewer" | "editor";
  members: (ShareMember & { role: "viewer" | "editor" })[];
  inheritedFrom: { id: string; name: string } | null;
  hasParent: boolean;
  canManage: boolean;
};

export type DriveItem = {
  id: string;
  name: string;
  kind: "file" | "folder";
  parentId: string | null;
  owner: ShareMember | null;
  accessMode: DriveAccessMode;
  permission: DrivePermission;
  sharing: DriveSharingStatus;
  size: number;
  mimeType: string | null;
  createdAt: string;
  updatedAt: string;
  publicToken: string | null;
  /** When the active public link stops working; null when there is no link or it never expires. */
  publicExpiresAt: string | null;
  trashedAt: string | null;
  hasPassword: boolean;
  isLocked: boolean;
  isProtected: boolean;
  /** Folders only: excluded from AI search by its owner (descendants inherit this). */
  searchExcluded: boolean;
  tags: string[];
  description: string;
  folderColor: string | null;
  folderEmoji: string | null;
  isFavorite: boolean;
  /** Virus scan state for files; absent when never scanned or the scan found nothing to report. */
  scanStatus?: DriveScanStatus;
  /** Files that look worth scanning (for example `invoice.pdf.exe`) and have no scan result yet. */
  scanSuggestion?: { level: "medium" | "high"; reasons: string[] };
};
/** A file's place in the AI search index; null from the server when search is not configured. */
export type SearchIndexStatus = {
  state: "queued" | "indexing" | "indexed" | "skipped" | "failed" | "not_indexed";
  skipReason: "too_large" | "unsupported" | "excluded" | "protected" | "empty" | "trashed" | null;
};
export type DriveScanStatus = "scanning" | "clean" | "suspicious" | "malicious";
export const FOLDER_COLORS = ["blue", "green", "amber", "red", "violet", "gray"] as const;
export type DriveFolderColor = (typeof FOLDER_COLORS)[number];
export type DriveListing = {
  items: DriveItem[];
  breadcrumbs: { id: string; name: string; permission: DrivePermission }[];
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
/**
 * An incoming item whose name is already used in the destination (case-insensitive, non-trashed).
 * `id` is the incoming item's id, or the client-chosen key for uploads; resolutions are keyed by it.
 */
export type DriveNameConflict = { id: string; name: string; kind: "file" | "folder"; existingId: string; existingKind: "file" | "folder" };
/**
 * replace: uploads become a new version of the existing file; moves/copies send the existing item to Trash.
 * keep-both: the incoming item gets a numbered name ("photo (1).jpg"). skip: the incoming item is left out.
 */
export type ConflictResolution = "replace" | "keep-both" | "skip";
export type ConflictResolutions = Record<string, ConflictResolution>;
export type ActionResult<T> = { success: true; data: T } | { success: false; error: string; lockedFolder?: LockedFolder; conflicts?: DriveNameConflict[] };
export type StorageQuota = { usedBytes: number; quotaBytes: number; memberUsedBytes: number; memberQuotaBytes: number };
export type StorageCategory = Exclude<DriveTypeFilter, "all" | "folder">;
/**
 * The drive's bytes split so the parts add up to `usedBytes`: current files by category, Trash (trashed files
 * and their versions), old versions of current files, and uploads still in progress.
 */
export type StorageUsageReport = StorageQuota & {
  fileCount: number;
  categories: { category: StorageCategory; bytes: number; files: number }[];
  trashBytes: number;
  versionBytes: number;
  uploadingBytes: number;
  /** Who added the bytes (files and versions); `id` null is everything from before ownership was tracked. */
  members: { id: string | null; name: string | null; email: string | null; bytes: number; isYou: boolean }[];
  /** Largest files this session may see. `folderId` is the folder that lists the file (in Trash when `trashed`); null = top level. */
  largestFiles: { id: string; name: string; size: number; mimeType: string | null; folderId: string | null; trashed: boolean }[];
};
export type DriveArchiveItem = Pick<DriveItem, "id" | "parentId" | "name" | "kind" | "size">;
export type DriveArchiveManifest = { rootIds: string[]; items: DriveArchiveItem[] };
export type DriveRestoreResult = { restoredToRoot: number };
export type EmptyTrashResult = { deleted: number; skippedLocked: number; pending: number };
/** What Empty Trash would delete for this session: `count` Trash entries holding `bytes`, and entries it must skip. */
export type TrashSummary = { count: number; bytes: number; skippedLocked: number };
export type DriveActivityAction = (typeof DRIVE_EVENT_ACTIONS)[number];
/**
 * One activity entry as a member may see it. Redacted entries (inside a protected folder this session
 * can't open) carry a placeholder name, no ids, no parent and no details.
 */
export type DriveActivityEvent = {
  id: string;
  at: string;
  action: DriveActivityAction;
  actor: { id: string | null; name: string; email: string | null };
  /** `name` is the name at the time of the event. `status` is where the item is now, for this session. */
  item: { id: string | null; name: string; kind: "file" | "folder"; redacted: boolean; status: "available" | "trashed" | "unavailable" };
  /** The item as listed now, when it is available to open or preview. */
  current: DriveItem | null;
  /** Folder the item is in after the event (`id` null = All files), by its current name; null when gone or not visible. */
  parent: { id: string | null; name: string; trashed: boolean } | null;
  details: Record<string, string | number | boolean | null>;
};
export type DriveActivityPage = { events: DriveActivityEvent[]; nextCursor: string | null };
export type DriveActivityMember = { id: string; name: string; email: string };
/** What an anonymous visitor may learn about an item in a public share: never tags, descriptions, owners or ids above the share. */
export type PublicShareItem = Pick<DriveItem, "id" | "name" | "kind" | "size" | "mimeType" | "updatedAt" | "folderColor" | "folderEmoji">;
export type PublicShareCrumb = Pick<DriveItem, "id" | "name" | "folderColor" | "folderEmoji">;
export type PublicFolderView = {
  share: { sharedByEmail: string | null; expiresAt: string | null };
  /** From the shared folder down to the folder being viewed (the last entry). */
  breadcrumbs: PublicShareCrumb[];
  items: PublicShareItem[];
  /** More items exist than one page shows. */
  truncated: boolean;
};
/** What a move changed, so it can be undone: each moved root's previous parent and name, and the items it sent to Trash. */
export type DriveMoveResult = { moved: { id: string; fromParentId: string | null }[]; renamed: { id: string; fromName: string }[]; replacedIds: string[] };
/** `ids`: the new copies' root ids. `replacedIds`: destination items sent to Trash by Replace. */
export type DriveCopyResult = { copied: number; ids: string[]; replacedIds: string[] };
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;
/** How an upload proceeds when its name is taken in the destination (Skip never reaches the server). */
export type UploadResolution = Exclude<ConflictResolution, "skip">;
/** Multipart `parts` lists only the parts still to send; `completedParts` are already stored (resumed uploads). */
export type UploadTicket =
  | { mode: "single"; id: string; url: string; headers: Record<string, string> }
  | { mode: "multipart"; id: string; partSize: number; parts: { partNumber: number; url: string }[]; completedParts: number[] };
/** An unfinished upload of the signed-in member that can continue from where it stopped. */
export type ResumableUpload = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  /** Destination folder; null = All files. */
  parentId: string | null;
  parentName: string | null;
  /** The upload becomes a new version of this existing file. */
  replaces: boolean;
  multipart: boolean;
  createdAt: string;
};
/** One content version of a file; the first entry of a listing is the current content (`current`, id = the file's id). */
export type DriveFileVersion = {
  id: string;
  current: boolean;
  size: number;
  mimeType: string | null;
  /** When this content was uploaded. */
  createdAt: string;
  /** When newer content replaced it; null for the current content. */
  replacedAt: string | null;
  createdByEmail: string | null;
};
