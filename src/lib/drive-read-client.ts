import type { ActionResult, DriveListInput, SemanticSearchInput } from "@/lib/drive-types";
import type { ActivityReadInput, DriveReadArgs, DriveReadOperation, DriveReadResult } from "@/lib/drive-read-contract";

let accessGeneration = 0;
const pendingReads = new Set<AbortController>();
export function cancelDriveReads() {
  accessGeneration += 1;
  for (const controller of pendingReads) controller.abort();
  pendingReads.clear();
}
if (typeof window !== "undefined") window.addEventListener("drive-access-changed", cancelDriveReads);

export function currentDriveAccessGeneration() { return accessGeneration; }
export function assertDriveAccessGeneration(generation: number) {
  if (generation !== accessGeneration) throw new DOMException("Drive access changed.", "AbortError");
}

async function readDrive<K extends DriveReadOperation>(operation: K, args: DriveReadArgs<K>, signal?: AbortSignal): Promise<DriveReadResult<K>> {
  signal?.throwIfAborted();
  const generation = accessGeneration;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  pendingReads.add(controller);
  try {
    const response = await fetch(`/api/drive/read/${operation}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Orole-Read": "1" },
      body: JSON.stringify({ args }),
      signal: controller.signal,
    });
    const result: DriveReadResult<K> = await response.json();
    controller.signal.throwIfAborted();
    assertDriveAccessGeneration(generation);
    if (!result || typeof result.success !== "boolean" || (!result.success && typeof result.error !== "string") || (!response.ok && result.success)) {
      throw new Error("The drive returned an invalid response. Please try again.");
    }
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    pendingReads.delete(controller);
  }
}

export const listDrive = (input: DriveListInput = {}, signal?: AbortSignal) => readDrive("listDrive", [input], signal);
export const getArchiveManifest = (ids: string[], signal?: AbortSignal) => readDrive("getArchiveManifest", [ids], signal);
export const getDownloadUrl = (id: string, signal?: AbortSignal) => readDrive("getDownloadUrl", [id], signal);
export const getPreviewUrl = (id: string, signal?: AbortSignal) => readDrive("getPreviewUrl", [id], signal);
export const getTrashSummary = (signal?: AbortSignal) => readDrive("getTrashSummary", [], signal);
export const listActivity = (input: ActivityReadInput = {}, signal?: AbortSignal) => readDrive("listActivity", [input], signal);
export const listActivityMembers = (signal?: AbortSignal) => readDrive("listActivityMembers", [], signal);
export const getItemSharing = (id: string, signal?: AbortSignal) => readDrive("getItemSharing", [id], signal);
export const listShareMembers = (signal?: AbortSignal) => readDrive("listShareMembers", [], signal);
export const getConnectedAgents = (signal?: AbortSignal) => readDrive("getConnectedAgents", [], signal);
export const listPinnedFolders = (signal?: AbortSignal) => readDrive("listPinnedFolders", [], signal);
export const getStorageUsage = (signal?: AbortSignal) => readDrive("getStorageUsage", [], signal);
export const listResumableUploads = (signal?: AbortSignal) => readDrive("listResumableUploads", [], signal);
export const listVersions = (id: string, signal?: AbortSignal) => readDrive("listVersions", [id], signal);
export const getVersionDownloadUrl = (id: string, signal?: AbortSignal) => readDrive("getVersionDownloadUrl", [id], signal);
export const getFileScanStatus = (id: string, signal?: AbortSignal) => readDrive("getFileScanStatus", [id], signal);
export const getPublicFileScanStatus = (token: string, signal?: AbortSignal) => readDrive("getPublicFileScanStatus", [token], signal);
export const getPublicAccess = (token: string, signal?: AbortSignal) => readDrive("getPublicAccess", [token], signal);
export const getPublicFolderFileAccess = (token: string, id: string, signal?: AbortSignal) => readDrive("getPublicFolderFileAccess", [token, id], signal);
export const getPublicFolderArchive = (token: string, id: string, signal?: AbortSignal) => readDrive("getPublicFolderArchive", [token, id], signal);
export const getSearchStatus = (id: string, signal?: AbortSignal) => readDrive("getSearchStatus", [id], signal);
export const searchContents = (input: SemanticSearchInput, signal?: AbortSignal) => readDrive("searchContents", [input], signal);
export const listChats = (signal?: AbortSignal) => readDrive("listChats", [], signal);
export const getChat = (id: string, signal?: AbortSignal) => readDrive("getChat", [id], signal);
export const getAssistantStatus = (signal?: AbortSignal) => readDrive("getAssistantStatus", [], signal);

type ThumbnailRequest = {
  id: string;
  generation: number;
  signal?: AbortSignal;
  resolve: (result: ActionResult<{ url: string | null }>) => void;
  reject: (error: unknown) => void;
};
let thumbnails: ThumbnailRequest[] = [];
let thumbnailTimer: number | undefined;

/** Coalesce visible queries without caching signed URLs past their TTL. */
export function getThumbnailUrl(id: string, signal?: AbortSignal): Promise<ActionResult<{ url: string | null }>> {
  signal?.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<ActionResult<{ url: string | null }>>();
  thumbnails.push({ id, signal, generation: accessGeneration, resolve, reject });
  thumbnailTimer ??= window.setTimeout(flushThumbnails, 0);
  return promise;
}

function flushThumbnails() {
  thumbnailTimer = undefined;
  const queued = thumbnails;
  thumbnails = [];
  const active = queued.filter((entry) => {
    if (entry.signal?.aborted || entry.generation !== accessGeneration) {
      entry.reject(new DOMException("Thumbnail request cancelled.", "AbortError"));
      return false;
    }
    return true;
  });
  const ids = [...new Set(active.map((entry) => entry.id))];
  for (let offset = 0; offset < ids.length; offset += 40) {
    const chunk = ids.slice(offset, offset + 40);
    const entries = active.filter((entry) => chunk.includes(entry.id));
    const controller = new AbortController();
    const abortUnused = () => {
      if (entries.every((entry) => entry.signal?.aborted)) controller.abort();
    };
    for (const entry of entries) entry.signal?.addEventListener("abort", abortUnused, { once: true });
    void readDrive("getThumbnailUrls", [chunk], controller.signal).then((result) => {
      for (const entry of entries) {
        if (entry.signal?.aborted || entry.generation !== accessGeneration) entry.reject(new DOMException("Thumbnail request cancelled.", "AbortError"));
        else entry.resolve(result.success ? { success: true, data: result.data[entry.id] ?? { url: null } } : result);
      }
    }, (error: unknown) => { for (const entry of entries) entry.reject(error); }).finally(() => {
      for (const entry of entries) entry.signal?.removeEventListener("abort", abortUnused);
    });
  }
}
