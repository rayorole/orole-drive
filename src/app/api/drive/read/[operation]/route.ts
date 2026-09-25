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
import type { DriveReadActions, DriveReadOperation } from "@/lib/drive-read-contract";

const reads: DriveReadActions = {
  listDrive, getArchiveManifest, getDownloadUrl, getPreviewUrl, getTrashSummary,
  listActivity, listActivityMembers, getItemSharing, listShareMembers, getConnectedAgents,
  listPinnedFolders, getStorageUsage, getThumbnailUrls, listResumableUploads,
  listVersions, getVersionDownloadUrl, getFileScanStatus, getPublicFileScanStatus,
  getPublicAccess, getPublicFolderFileAccess, getPublicFolderArchive,
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
  // Reverse proxies can give Next an internal request URL. Only deployment-owned
  // configuration selects trusted browser origins; forwarded headers cannot add one.
  const origin = request.headers.get("origin");
  const publicUrls = [
    process.env.BETTER_AUTH_URL ?? (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : undefined),
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
    process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`,
  ];
  const trustedOrigin = publicUrls.some((url) => url && origin === new URL(url).origin);
  if (!trustedOrigin ||
      request.headers.get("x-orole-read") !== "1" ||
      request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
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
