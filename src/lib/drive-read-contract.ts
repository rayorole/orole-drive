import type { ConnectedAgents } from "@/app/actions/mcp-status";
import type { FileScanStatus } from "@/app/actions/virustotal";
import type {
  ActionResult, DriveActivityAction, DriveActivityMember, DriveActivityPage,
  DriveArchiveManifest, DriveChat, DriveChatSummary, DriveFileVersion, DriveItem, DriveListInput, DriveListing,
  ItemSharing, ResumableUpload, SearchIndexStatus, SemanticSearchInput, SemanticSearchResult, ShareMember, StorageUsageReport, TrashSummary,
} from "@/lib/drive-types";

export type ActivityReadInput = {
  cursor?: string | null; limit?: number; itemId?: string; folderId?: string;
  actorId?: string; actions?: DriveActivityAction[];
};
export type PublicFileUrls = { downloadUrl: string; previewUrl: string | null };
export type ThumbnailUrls = Record<string, { url: string | null }>;

/** The HTTP allowlist contains reads only; mutations remain Server Actions. */
export interface DriveReadContract {
  listDrive: { args: [input?: DriveListInput]; data: DriveListing };
  getArchiveManifest: { args: [ids: string[]]; data: DriveArchiveManifest };
  getDownloadUrl: { args: [id: string]; data: { url: string } };
  getPreviewUrl: { args: [id: string]; data: { url: string | null } };
  getTrashSummary: { args: []; data: TrashSummary };
  listActivity: { args: [input?: ActivityReadInput]; data: DriveActivityPage };
  listActivityMembers: { args: []; data: DriveActivityMember[] };
  getItemSharing: { args: [id: string]; data: ItemSharing };
  listShareMembers: { args: []; data: ShareMember[] };
  getConnectedAgents: { args: []; data: ConnectedAgents };
  listPinnedFolders: { args: []; data: DriveItem[] };
  getStorageUsage: { args: []; data: StorageUsageReport };
  getThumbnailUrls: { args: [ids: string[]]; data: ThumbnailUrls };
  listResumableUploads: { args: []; data: ResumableUpload[] };
  listVersions: { args: [id: string]; data: DriveFileVersion[] };
  getVersionDownloadUrl: { args: [id: string]; data: { url: string } };
  getFileScanStatus: { args: [id: string]; data: FileScanStatus };
  getPublicFileScanStatus: { args: [token: string]; data: FileScanStatus };
  getPublicAccess: { args: [token: string]; data: PublicFileUrls };
  getPublicFolderFileAccess: { args: [token: string, id: string]; data: PublicFileUrls };
  getPublicFolderArchive: { args: [token: string, id: string]; data: DriveArchiveManifest };
  getSearchStatus: { args: [id: string]; data: SearchIndexStatus | null };
  searchContents: { args: [input: SemanticSearchInput]; data: SemanticSearchResult };
  listChats: { args: []; data: DriveChatSummary[] };
  getChat: { args: [id: string]; data: DriveChat };
}

export type DriveReadOperation = keyof DriveReadContract;
export type DriveReadArgs<K extends DriveReadOperation> = DriveReadContract[K]["args"];
export type DriveReadResult<K extends DriveReadOperation> = ActionResult<DriveReadContract[K]["data"]>;
export type DriveReadActions = {
  [K in DriveReadOperation]: (...args: DriveReadArgs<K>) => Promise<DriveReadResult<K>>;
};
