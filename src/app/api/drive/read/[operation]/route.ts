import "server-only";

import { z } from "zod";
import { listDrive, getArchiveManifest, getDownloadUrl, getPreviewUrl, getTrashSummary } from "@/app/actions/drive";
import { listActivity, listActivityMembers } from "@/app/actions/activity";
import { getItemSharing, listShareMembers } from "@/app/actions/item-access";
import { getConnectedAgents } from "@/app/actions/mcp-status";
import { listPinnedFolders } from "@/app/actions/pinned-folders";
import { getStorageUsage } from "@/app/actions/storage-usage";
import { getThumbnailUrls } from "@/app/actions/thumbnails";
import { listResumableUploads } from "@/app/actions/uploads";
import { listVersions, getVersionDownloadUrl } from "@/app/actions/versions";
import { getFileScanStatus, getPublicFileScanStatus } from "@/app/actions/virustotal";
import { getPublicAccess, getPublicFolderFileAccess, getPublicFolderArchive } from "@/app/actions/public";
import { getSearchStatus, searchContents } from "@/app/actions/search";
import { getAssistantStatus, getChat, listChats } from "@/app/actions/chat";
import type { DriveReadActions, DriveReadOperation } from "@/lib/drive-read-contract";
import { isTrustedDriveRequest } from "@/lib/drive-request";

const reads: DriveReadActions = {
  listDrive, getArchiveManifest, getDownloadUrl, getPreviewUrl, getTrashSummary,
  listActivity, listActivityMembers, getItemSharing, listShareMembers, getConnectedAgents,
  listPinnedFolders, getStorageUsage, getThumbnailUrls, listResumableUploads,
  listVersions, getVersionDownloadUrl, getFileScanStatus, getPublicFileScanStatus,
  getPublicAccess, getPublicFolderFileAccess, getPublicFolderArchive, getSearchStatus, searchContents,
  listChats, getChat, getAssistantStatus,
};
const requestSchema = z.object({ args: z.array(z.unknown()).max(2) }).strict();

// POST keeps complex filters, selected ids and share tokens out of URL/history logs.
// Each allowlisted action retains its existing session/ACL or public-token authorization.
export async function POST(request: Request, context: { params: Promise<{ operation: string }> }) {
  const started = performance.now();
  const respond = (body: unknown, status = 200) => Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Vary": "Cookie, Origin",
      "Server-Timing": `read;dur=${(performance.now() - started).toFixed(1)}`,
    },
  });
  if (!isTrustedDriveRequest(request, "x-orole-read")) {
    return respond({ success: false, error: "This request must come from the drive. Refresh and try again." }, 403);
  }
  const { operation } = await context.params;
  if (!Object.hasOwn(reads, operation)) return respond({ success: false, error: "That read is not available." }, 404);
  let args: unknown[];
  try {
    args = requestSchema.parse(await request.json()).args;
  } catch {
    return respond({ success: false, error: "Check the information and try again." }, 400);
  }
  try {
    // Inputs remain untrusted: each action owns its existing runtime validation.
    const read = reads[operation as DriveReadOperation] as (...args: unknown[]) => Promise<unknown>;
    return respond(await read(...args));
  } catch {
    return respond({ success: false, error: "The drive could not complete that request. Please try again." }, 500);
  }
}
