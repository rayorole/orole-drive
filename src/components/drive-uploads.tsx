"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, CircleAlert, FolderUp, History, Upload, X } from "lucide-react";
import { beginUpload, cancelUpload, completeUpload } from "@/app/actions/drive";
import { beginUploads, ensureFolders, resumeUpload } from "@/app/actions/uploads";
import { listResumableUploads } from "@/lib/drive-read-client";
import { MAX_UPLOAD_BYTES } from "@/lib/drive-types";
import type { DriveListing, DriveNameConflict, ResumableUpload, UploadResolution, UploadTicket } from "@/lib/drive-types";
import { completedBytes, transferUpload, uploadTicketNeedsRefresh } from "@/lib/upload-transfer";
import { UploadRate } from "@/lib/upload-rate";
import { chooseDirectoryFiles, chooseFile, snapshotDataTransfer, treeFromDirectoryHandle, treeFromDrop, treeFromRelativeFiles } from "@/lib/directory-upload";
import type { UploadDirectoryHandle, UploadTreeNode } from "@/lib/directory-upload";
import { DriveAccessError, useFolderAccess } from "@/components/folder-access";
import { useNameConflicts } from "@/components/name-conflicts";
import { refreshFileContent } from "@/components/drive-versions-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/cubby-ui/progress";
import { Spinner } from "@/components/spinner";
import { formatBytes } from "@/lib/format-bytes";
import { TruncatedText } from "@/components/hint";

type UploadStatus = "checking" | "conflict" | "queued" | "preparing" | "uploading" | "saving" | "cancelling" | "complete" | "skipped" | "cancelled" | "error";
type UploadJob = {
  key: string;
  file: File;
  /** The file's name, or its path inside an uploaded folder; shown when the name is taken. */
  label: string;
  parentId: string | null;
  /** Where the member uploaded to, named in name-conflict prompts. */
  destinationName: string;
  status: UploadStatus;
  progress: number;
  uploadedBytes: number;
  /** Bytes already stored when this attempt started (resumed uploads); they don't count toward the speed. */
  resumedBytes: number;
  bytesPerSecond: number | null;
  rate?: UploadRate;
  error?: string;
  uploadId?: string;
  ticket?: UploadTicket;
  /** Continues this unfinished upload instead of starting a new one. */
  resumeId?: string;
  resolution?: UploadResolution;
  /** Finished as a new version of an existing file. */
  replaced: boolean;
  controller?: AbortController;
  cancelled: boolean;
};

type FolderPreparation = {
  key: string;
  name: string;
  status: "preparing" | "cancelling" | "complete" | "cancelled" | "error";
  controller: AbortController;
  foldersCreated: number;
  filesQueued: number;
  message: string;
};

/** An unfinished upload from an earlier visit or another device, which can continue where it stopped. */
type InterruptedUpload = ResumableUpload & {
  /** The local file's name and timestamp, when this browser started the upload. */
  fileName: string;
  lastModified: number | null;
  discarding: boolean;
  error?: string;
};

const STORED_UPLOADS_KEY = "orole-drive:uploads";
/** What this browser remembers about uploads it started, to recognise the same file when resuming after a reload. */
type StoredUpload = { uploadId: string; name: string; size: number; lastModified: number; type: string; parentId: string | null };

function storedUploads(): StoredUpload[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORED_UPLOADS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is StoredUpload =>
      typeof entry?.uploadId === "string" && typeof entry.name === "string" && typeof entry.size === "number" && typeof entry.lastModified === "number") : [];
  } catch {
    return [];
  }
}

function storeUploads(entries: StoredUpload[]) {
  try {
    if (entries.length) localStorage.setItem(STORED_UPLOADS_KEY, JSON.stringify(entries));
    else localStorage.removeItem(STORED_UPLOADS_KEY);
  } catch {
    // Storage may be unavailable (private browsing, full quota); resuming then just can't check the file's date.
  }
}

function forgetUpload(uploadId: string) {
  storeUploads(storedUploads().filter((entry) => entry.uploadId !== uploadId));
}

function withPatch(uploads: InterruptedUpload[], id: string, patch: Partial<InterruptedUpload>) {
  return uploads.map((upload) => upload.id === id ? { ...upload, ...patch } : upload);
}

/** Why `file` isn't the file an interrupted upload was sending, or null when it is. */
function resumeMismatch(upload: InterruptedUpload, file: File): string | null {
  // Keep both may have numbered the name in Drive ("photo (1).jpg"); the local file keeps its own.
  const names = [upload.fileName, upload.name, upload.name.replace(/ \(\d+\)(?=(\.[^.]*)?$)/, "")].map((name) => name.toLowerCase());
  if (file.size !== upload.size || !names.includes(file.name.toLowerCase())) {
    return `That’s a different file. Choose “${upload.fileName}” (${formatBytes(upload.size)}) to resume.`;
  }
  if (upload.lastModified !== null && file.lastModified !== upload.lastModified) {
    return `“${file.name}” has changed since this upload started. Discard it and upload the file again.`;
  }
  return null;
}

function plural(count: number, word: string) {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function isPreparationPending(preparation: FolderPreparation) {
  return preparation.status === "preparing" || preparation.status === "cancelling";
}

function isUploadPending(job: UploadJob) {
  return !!job.controller || ["checking", "conflict", "queued", "preparing", "uploading", "saving", "cancelling"].includes(job.status);
}

/** Ordinary files reserve in batches; resumes already have a durable reservation. */
function createUploadJob(file: File, parentId: string | null, destinationName: string, label: string, status: "checking" | "queued"): UploadJob {
  return {
    key: crypto.randomUUID(), file, label, parentId, destinationName, cancelled: false, replaced: false,
    progress: 0, uploadedBytes: 0, resumedBytes: 0, bytesPerSecond: null,
    status: file.size > MAX_UPLOAD_BYTES ? "error" : status,
    error: file.size > MAX_UPLOAD_BYTES ? `This file exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.` : undefined,
  };
}

export type DriveUploads = {
  jobs: UploadJob[];
  preparations: FolderPreparation[];
  interrupted: InterruptedUpload[];
  pending: number;
  addFiles: (files: File[], parentId: string | null) => void;
  addFolderFiles: (files: File[], parentId: string | null) => void;
  addDrop: (transfer: DataTransfer, parentId: string | null) => void;
  chooseFolder: (parentId: string | null) => void;
  cancel: (key: string) => void;
  clearFinished: () => void;
  resume: (upload: InterruptedUpload) => void;
  discard: (upload: InterruptedUpload) => void;
};

export function useDriveUploads(): DriveUploads {
  const queryClient = useQueryClient();
  const access = useFolderAccess();
  const { resolveConflicts } = useNameConflicts();
  const preparationsRef = useRef<FolderPreparation[]>([]);
  const [preparations, setPreparations] = useState<FolderPreparation[]>([]);
  const jobsRef = useRef<UploadJob[]>([]);
  const running = useRef(0);
  const mounted = useRef(true);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [interrupted, setInterrupted] = useState<InterruptedUpload[]>([]);
  const publish = useCallback(() => {
    if (mounted.current) {
      setJobs(jobsRef.current.map((job) => ({ ...job })));
      setPreparations(preparationsRef.current.map((preparation) => ({ ...preparation })));
    }
  }, []);

  // Names the destination in conflict prompts, from folder listings already loaded.
  const folderName = useCallback((parentId: string | null) => {
    if (!parentId) return "All files";
    for (const [, listing] of queryClient.getQueriesData<DriveListing>({ queryKey: ["drive"] })) {
      if (typeof listing !== "object" || listing === null || !("items" in listing)) continue;
      if (listing.currentFolder?.id === parentId) return listing.currentFolder.name;
      const folder = listing.items.find((item) => item.id === parentId);
      if (folder) return folder.name;
    }
    return "This folder";
  }, [queryClient]);

  /**
   * One prompt for every clash among `waiting` (status "conflict"), so "Do this for all" covers the batch.
   * Returns the jobs that continue, as `accepted` with their answer; the rest end skipped or cancelled.
   */
  const askAbout = useCallback(async (conflicts: DriveNameConflict[], waiting: UploadJob[], destinationName: string, accepted: "queued" | "preparing") => {
    const labels = new Map(waiting.map((job) => [job.key, job.label]));
    const answers = await resolveConflicts(conflicts.map((conflict) => ({ ...conflict, name: labels.get(conflict.id) ?? conflict.name })), { operation: "upload", destinationName });
    const continuing: UploadJob[] = [];
    for (const job of waiting) {
      // Cancelled while the prompt was open.
      if (job.status !== "conflict") continue;
      const answer = answers?.[job.key];
      if (answer === "replace" || answer === "keep-both") {
        job.resolution = answer;
        job.status = accepted;
        continuing.push(job);
      } else if (answer === "skip") {
        job.status = "skipped";
      } else {
        job.cancelled = true;
        job.status = "cancelled";
        job.error = "Upload cancelled.";
      }
    }
    publish();
    return continuing;
  }, [publish, resolveConflicts]);

  const cancelReservedJob = useCallback(async (job: UploadJob) => {
    if (!job.uploadId) return;
    const id = job.uploadId;
    job.status = "cancelling";
    storeUploads([...storedUploads().filter((entry) => entry.uploadId !== id), {
      uploadId: id, name: job.file.name, size: job.file.size, lastModified: job.file.lastModified, type: job.file.type, parentId: job.parentId,
    }]);
    publish();
    try {
      const result = await cancelUpload(id);
      if (!result.success) throw new Error(result.error);
      forgetUpload(id);
      job.status = "cancelled";
      job.error = "Upload cancelled.";
    } catch (error) {
      job.status = "error";
      job.error = `Transfer cancelled, but the unfinished upload could not be discarded: ${error instanceof Error ? error.message : "Try again."}`;
      setInterrupted((current) => current.some((upload) => upload.id === id) ? current : [...current, {
        id, name: job.file.name, fileName: job.file.name, size: job.file.size, mimeType: job.file.type || "application/octet-stream",
        parentId: job.parentId, parentName: job.destinationName, replaces: job.resolution === "replace", multipart: job.ticket?.mode === "multipart",
        createdAt: new Date().toISOString(), lastModified: job.file.lastModified, discarding: false, error: job.error,
      }]);
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["storage-usage"] });
      publish();
    }
  }, [publish, queryClient]);

  /** Reserve once, collecting real conflicts into the existing shared batch prompt. */
  const admit = useCallback(async (batch: UploadJob[], destinationName: string) => {
    jobsRef.current.push(...batch);
    publish();
    const checking = batch.filter((job) => job.status === "checking");
    const conflicts: DriveNameConflict[] = [];
    try {
      for (let start = 0; start < checking.length; start += 20) {
        const group = checking.slice(start, start + 20).filter((job) => !job.cancelled);
        if (!group.length) continue;
        const results = await access.run(() => beginUploads(group.map((job) => ({
          key: job.key, name: job.file.name, size: job.file.size, mimeType: job.file.type || "application/octet-stream", parentId: job.parentId,
        }))));
        for (const { key, result } of results) {
          const job = group.find((entry) => entry.key === key)!;
          if (result.success) {
            job.uploadId = result.data.id;
            job.ticket = result.data;
            if (job.cancelled) {
              await cancelReservedJob(job);
              continue;
            }
            job.status = "queued";
          } else if (!job.cancelled) {
            if (result.conflicts?.length) {
              conflicts.push(...result.conflicts);
              job.status = "conflict";
            } else if (result.lockedFolder) {
              // The regular reservation path prompts for access and retries under a fresh session/ACL check.
              job.status = "queued";
            } else {
              job.status = "error";
              job.error = result.error;
            }
          }
        }
        void queryClient.invalidateQueries({ queryKey: ["storage-usage"] });
        publish();
      }
    } catch (error) {
      for (const job of checking) {
        if (job.status !== "checking") continue;
        job.status = "error";
        job.error = error instanceof Error ? error.message : "Could not reserve these uploads. Try again.";
      }
      publish();
    }
    const waiting = checking.filter((job) => job.status === "conflict");
    if (waiting.length) await askAbout(conflicts.filter((conflict) => waiting.some((job) => job.key === conflict.id)), waiting, destinationName, "queued");
  }, [access, askAbout, cancelReservedJob, publish, queryClient]);

  const run = useCallback(async (job: UploadJob) => {
    const controller = new AbortController();
    job.controller = controller;
    job.status = "preparing";
    const stopProgress = () => {
      job.rate = undefined;
      job.bytesPerSecond = null;
    };
    publish();
    try {
      let ticket: UploadTicket | null = job.ticket ?? null;
      if (ticket && uploadTicketNeedsRefresh(ticket)) {
        job.resumeId = ticket.id;
        ticket = null;
      }
      while (!ticket) {
        try {
          ticket = await access.run(() => {
            controller.signal.throwIfAborted();
            return job.resumeId ? resumeUpload(job.resumeId) : beginUpload({
              key: job.key, name: job.file.name, size: job.file.size, mimeType: job.file.type || "application/octet-stream", parentId: job.parentId, resolution: job.resolution,
            });
          });
        } catch (error) {
          // Reservation reported a real name conflict; retain the same conflict-resolution UX.
          if (!(error instanceof DriveAccessError && error.conflicts?.length) || job.resolution || job.cancelled) throw error;
          job.status = "conflict";
          publish();
          const continuing = await askAbout(error.conflicts, [job], job.destinationName, "preparing");
          controller.signal.throwIfAborted();
          if (!continuing.length) return;
        }
      }
      const uploadId = ticket.id;
      job.uploadId = uploadId;
      storeUploads([...storedUploads().filter((entry) => entry.uploadId !== uploadId), {
        uploadId, name: job.file.name, size: job.file.size, lastModified: job.file.lastModified, type: job.file.type, parentId: job.parentId,
      }]);
      controller.signal.throwIfAborted();
      job.resumedBytes = completedBytes(ticket, job.file.size);
      job.status = "uploading";
      job.rate = new UploadRate();
      publish();
      await transferUpload(job.file, ticket, controller.signal, (bytes) => {
        job.uploadedBytes = bytes;
      });
      controller.signal.throwIfAborted();
      stopProgress();
      job.status = "saving";
      job.progress = 100;
      publish();
      const item = await access.run(() => completeUpload(uploadId));
      forgetUpload(uploadId);
      job.status = "complete";
      // A replacement completes as the existing file, whose contents just changed.
      job.replaced = item.id !== uploadId;
      if (job.replaced) refreshFileContent(queryClient, item.id);
      else void queryClient.invalidateQueries({ queryKey: ["drive"] });
      void queryClient.invalidateQueries({ queryKey: ["storage-usage"] });
    } catch (error) {
      controller.abort();
      stopProgress();
      job.status = job.cancelled ? "cancelled" : "error";
      job.error = job.cancelled ? "Upload cancelled." : error instanceof Error ? error.message : "Could not upload this file. Try again.";
      publish();
      if (job.uploadId) {
        forgetUpload(job.uploadId);
        try {
          const result = await cancelUpload(job.uploadId);
          if (!result.success) job.error = `${job.error} Temporary upload cleanup failed: ${result.error}`;
        } catch {
          job.error = `${job.error} Temporary upload cleanup could not finish.`;
        }
      }
    } finally {
      stopProgress();
      job.controller = undefined;
      running.current -= 1;
      publish();
      void queryClient.invalidateQueries({ queryKey: ["storage-usage"] });
    }
  }, [access, askAbout, publish, queryClient]);

  useEffect(() => {
    for (const job of jobsRef.current) {
      if (running.current >= 3) break;
      if (job.status !== "queued") continue;
      running.current += 1;
      void run(job);
    }
  }, [jobs, run]);

  const uploading = jobs.some((job) => job.status === "uploading");
  useEffect(() => {
    if (!uploading) return;
    const timer = window.setInterval(() => {
      for (const job of jobsRef.current) {
        if (job.status !== "uploading" || !job.rate) continue;
        job.progress = job.file.size ? Math.floor(job.uploadedBytes / job.file.size * 100) : 0;
        job.bytesPerSecond = job.rate.sample(job.uploadedBytes - job.resumedBytes);
      }
      publish();
    }, 500);
    return () => window.clearInterval(timer);
  }, [uploading, publish]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const preparation of preparationsRef.current) {
        if (isPreparationPending(preparation)) preparation.controller.abort();
      }
      for (const job of jobsRef.current) {
        if (["checking", "conflict", "queued", "preparing", "uploading"].includes(job.status)) {
          job.cancelled = true;
          job.status = "cancelled";
          job.bytesPerSecond = null;
          job.rate = undefined;
          job.controller?.abort();
          if (job.ticket && !job.controller) void cancelUpload(job.ticket.id).catch(() => undefined);
        }
      }
    };
  }, []);

  // Unfinished uploads from earlier visits or other devices; this browser's notes add each file's date.
  useEffect(() => {
    let active = true;
    void listResumableUploads().then((result) => {
      if (!active || !result.success) return;
      const stored = new Map(storedUploads().map((entry) => [entry.uploadId, entry]));
      // Forget uploads the drive no longer has (finished, cancelled or cleaned up).
      storeUploads(result.data.flatMap((upload) => stored.get(upload.id) ?? []));
      setInterrupted(result.data.map((upload) => {
        const local = stored.get(upload.id);
        return { ...upload, fileName: local?.name ?? upload.name, lastModified: local?.lastModified ?? null, discarding: false };
      }));
    }, () => undefined);
    return () => { active = false; };
  }, []);

  const pending = jobs.filter(isUploadPending).length + preparations.filter(isPreparationPending).length;
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const addFiles = useCallback((files: File[], parentId: string | null) => {
    const destinationName = folderName(parentId);
    void admit(files.map((file) => createUploadJob(file, parentId, destinationName, file.name, "checking")), destinationName);
  }, [admit, folderName]);

  const prepare = useCallback((name: string, parentId: string | null, readTree: (signal: AbortSignal) => Promise<UploadTreeNode[]>) => {
    const preparation: FolderPreparation = {
      key: crypto.randomUUID(), name, status: "preparing", controller: new AbortController(),
      foldersCreated: 0, filesQueued: 0, message: "Reading folders…",
    };
    preparationsRef.current.push(preparation);
    publish();
    const signal = preparation.controller.signal;
    const destinationName = folderName(parentId);
    void (async () => {
      try {
        const roots = await readTree(signal);
        signal.throwIfAborted();
        if (!roots.length) {
          preparation.status = "cancelled";
          preparation.message = "No files or folders were selected.";
          return;
        }
        type FolderNode = { key: string; name: string; label: string; parentKey?: string; resolution?: UploadResolution };
        const folders: FolderNode[] = [];
        const selectedFiles: { file: File; label: string; parentKey?: string }[] = [];
        const flatten = (nodes: UploadTreeNode[], parentKey?: string, path = "") => {
          for (const node of nodes) {
            if (node.kind === "file") selectedFiles.push({ file: node.file, label: `${path}${node.file.name}`, parentKey });
            else {
              const key = crypto.randomUUID();
              folders.push({ key, name: node.name, label: `${path}${node.name}`, parentKey });
              flatten(node.children, key, `${path}${node.name}/`);
            }
          }
        };
        flatten(roots);
        const resolved = new Map<string, string>();
        const skippedKeys = new Set<string>();
        let merged = 0;
        let skipped = 0;
        for (let start = 0; start < folders.length; start += 32) {
          const chunk = folders.slice(start, start + 32);
          for (;;) {
            signal.throwIfAborted();
            for (const node of chunk) if (node.parentKey && skippedKeys.has(node.parentKey)) skippedKeys.add(node.key);
            const pending = chunk.filter((node) => !skippedKeys.has(node.key));
            if (!pending.length) break;
            preparation.message = `Creating folders… ${preparation.foldersCreated} created`;
            publish();
            try {
              const results = await access.run(() => {
                signal.throwIfAborted();
                return ensureFolders(pending.map((node) => ({
                  key: node.key, name: node.name, resolution: node.resolution,
                  parentId: node.parentKey ? resolved.get(node.parentKey) ?? null : parentId,
                  parentKey: node.parentKey && !resolved.has(node.parentKey) ? node.parentKey : undefined,
                })));
              });
              for (const result of results) {
                resolved.set(result.key, result.folder.id);
                if (result.created) preparation.foldersCreated += 1;
                else merged += 1;
              }
              signal.throwIfAborted();
              break;
            } catch (error) {
              if (!(error instanceof DriveAccessError && error.conflicts?.length)) throw error;
              const labels = new Map(chunk.map((node) => [node.key, node.label]));
              const answers = await resolveConflicts(error.conflicts.map((conflict) => ({ ...conflict, name: labels.get(conflict.id) ?? conflict.name })), { operation: "upload", destinationName });
              signal.throwIfAborted();
              if (!answers) throw new DOMException("Folder upload cancelled.", "AbortError");
              for (const conflict of error.conflicts) {
                const answer = answers[conflict.id];
                if (!answer) throw new DOMException("Folder upload cancelled.", "AbortError");
                if (answer === "skip") { skippedKeys.add(conflict.id); skipped += 1; }
                else chunk.find((node) => node.key === conflict.id)!.resolution = answer;
              }
            }
          }
        }
        const files = selectedFiles.filter((entry) => !entry.parentKey || !skippedKeys.has(entry.parentKey)).map((entry) =>
          createUploadJob(entry.file, entry.parentKey ? resolved.get(entry.parentKey)! : parentId, destinationName, entry.label, "checking"));
        signal.throwIfAborted();
        preparation.filesQueued = files.length;
        preparation.status = "complete";
        preparation.message = [
          preparation.foldersCreated ? `${plural(preparation.foldersCreated, "folder")} created` : "",
          merged ? `${plural(merged, "folder")} merged with existing ones` : "",
          skipped ? `${plural(skipped, "folder")} skipped` : "",
          `${plural(files.length, "file")} added to the queue`,
        ].filter(Boolean).join(" · ");
        // Only queue files once their entire destination hierarchy exists.
        void admit(files, destinationName);
      } catch (error) {
        const cancelled = signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        preparation.status = cancelled ? "cancelled" : "error";
        const reason = cancelled ? "Folder upload cancelled." : error instanceof Error ? error.message : "Could not read this folder. Choose it again.";
        preparation.message = `${reason}${preparation.foldersCreated ? ` ${preparation.foldersCreated} created folders remain in Drive; no files were queued.` : ""}`;
      } finally {
        if (preparation.foldersCreated) void queryClient.invalidateQueries({ queryKey: ["drive"] });
        void queryClient.invalidateQueries({ queryKey: ["storage-usage"] });
        publish();
      }
    })();
  }, [access, admit, folderName, publish, queryClient, resolveConflicts]);

  const addFolderFiles = useCallback((files: File[], parentId: string | null) => {
    if (!files.length) return;
    prepare(files[0].webkitRelativePath.split("/")[0] || "Selected folder", parentId, async (signal) => {
      signal.throwIfAborted();
      return treeFromRelativeFiles(files);
    });
  }, [prepare]);

  const addDrop = useCallback((transfer: DataTransfer, parentId: string | null) => {
    // Must run synchronously in the drop event, not inside an async callback.
    try {
      const snapshot = snapshotDataTransfer(transfer);
      if (!snapshot.sources.length && !snapshot.files.length) return;
      prepare("Dropped files and folders", parentId, (signal) => treeFromDrop(snapshot, signal));
    } catch (error) {
      prepare("Dropped files and folders", parentId, async () => { throw error; });
    }
  }, [prepare]);

  const chooseFolder = useCallback((parentId: string | null) => {
    const picker = (window as Window & { showDirectoryPicker?: (options: { mode: "read" }) => Promise<UploadDirectoryHandle> }).showDirectoryPicker;
    prepare("Selected folder", parentId, async (signal) => {
      if (picker) {
        let handle: UploadDirectoryHandle | undefined;
        try {
          handle = await picker.call(window, { mode: "read" });
        } catch (error) {
          // Browsers may expose the API but prohibit it in the current context.
          if (!(error instanceof DOMException) || !["SecurityError", "NotSupportedError"].includes(error.name)) throw error;
        }
        signal.throwIfAborted();
        if (handle) return [await treeFromDirectoryHandle(handle, signal)];
      }
      const files = await chooseDirectoryFiles(signal);
      signal.throwIfAborted();
      return treeFromRelativeFiles(files);
    });
  }, [prepare]);

  const cancel = useCallback((key: string) => {
    const preparation = preparationsRef.current.find((entry) => entry.key === key);
    if (preparation && isPreparationPending(preparation)) {
      preparation.status = "cancelling";
      preparation.message = "Cancelling…";
      preparation.controller.abort();
      publish();
      return;
    }
    const job = jobsRef.current.find((entry) => entry.key === key);
    if (!job || !["checking", "conflict", "queued", "preparing", "uploading"].includes(job.status)) return;
    job.cancelled = true;
    job.status = "cancelled";
    job.bytesPerSecond = null;
    job.rate = undefined;
    job.controller?.abort();
    if (job.ticket && !job.controller) void cancelReservedJob(job);
    publish();
  }, [cancelReservedJob, publish]);

  const clearFinished = useCallback(() => {
    jobsRef.current = jobsRef.current.filter(isUploadPending);
    preparationsRef.current = preparationsRef.current.filter(isPreparationPending);
    // Hidden for this visit only; they're listed again after a reload until resumed, discarded or expired.
    setInterrupted([]);
    publish();
  }, [publish]);

  const resume = useCallback(async (upload: InterruptedUpload) => {
    const file = await chooseFile();
    if (!file) return;
    const problem = resumeMismatch(upload, file);
    if (problem) {
      setInterrupted((current) => withPatch(current, upload.id, { error: problem }));
      return;
    }
    setInterrupted((current) => current.filter((entry) => entry.id !== upload.id));
    const job = createUploadJob(file, upload.parentId, upload.parentName ?? "All files", upload.name, "queued");
    job.resumeId = upload.id;
    jobsRef.current.push(job);
    publish();
  }, [publish]);

  const discard = useCallback(async (upload: InterruptedUpload) => {
    setInterrupted((current) => withPatch(current, upload.id, { discarding: true, error: undefined }));
    try {
      await access.run(() => cancelUpload(upload.id));
      forgetUpload(upload.id);
      setInterrupted((current) => current.filter((entry) => entry.id !== upload.id));
      // Storage usage counts unfinished uploads.
      void queryClient.invalidateQueries({ queryKey: ["storage-usage"] });
    } catch (error) {
      setInterrupted((current) => withPatch(current, upload.id, { discarding: false, error: error instanceof Error ? error.message : "Could not discard this upload. Try again." }));
    }
  }, [access, queryClient]);

  return { jobs, preparations, interrupted, pending, addFiles, addFolderFiles, addDrop, chooseFolder, cancel, clearFinished, resume, discard };
}

function jobStatusText(job: UploadJob) {
  switch (job.status) {
    case "checking": return "Checking…";
    case "conflict": return "Needs your choice";
    case "queued": return "Queued";
    case "preparing": return job.resumeId ? "Resuming…" : "Preparing…";
    case "cancelling": return "Cancelling…";
    case "saving": return "Finishing…";
    case "complete": return job.replaced ? "Uploaded as a new version" : "Uploaded";
    case "skipped": return "Skipped";
    case "cancelled": return job.controller ? "Cancelling…" : job.error || "Cancelled";
    default: return job.error;
  }
}

export function DriveUploadQueue({ uploads }: { uploads: DriveUploads }) {
  const [collapsed, setCollapsed] = useState(false);
  const { jobs, preparations, interrupted, pending, cancel, clearFinished, resume, discard } = uploads;
  if (!jobs.length && !preparations.length && !interrupted.length) return null;
  const preparing = preparations.filter(isPreparationPending).length;
  const errors = jobs.filter((job) => job.status === "error").length + preparations.filter((preparation) => preparation.status === "error").length;
  const title = pending ? preparing ? "Preparing folder uploads…" : `Uploading ${pending} ${pending === 1 ? "file" : "files"}`
    : errors ? `${errors} ${errors === 1 ? "upload needs" : "uploads need"} attention`
    : jobs.length || preparations.length ? "Uploads finished"
    : `${plural(interrupted.length, "upload")} can be resumed`;
  return (
    <section aria-label="File uploads" className="notification-surface fixed bottom-4 right-4 z-30 w-[calc(100%-2rem)] overflow-hidden sm:w-96">
      <div className="flex items-center gap-2 px-4 py-3">
        {pending ? <Spinner /> : errors ? <CircleAlert className="size-4 text-destructive" /> : jobs.length || preparations.length ? <Check className="size-4 text-primary" /> : <History className="size-4 text-muted-foreground" />}
        <p className="min-w-0 flex-1 text-sm font-medium" aria-live="polite">{title}</p>
        <Button variant="ghost" size="icon-sm" aria-expanded={!collapsed} aria-controls="upload-jobs" aria-label={collapsed ? "Expand uploads" : "Collapse uploads"} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronUp /> : <ChevronDown />}</Button>
        {!pending && <Button variant="ghost" size="icon-sm" aria-label="Dismiss upload queue" onClick={clearFinished}><X /></Button>}
      </div>
      {!collapsed && <div id="upload-jobs" className="max-h-72 overflow-y-auto border-t">
        {interrupted.length > 0 && <div role="group" aria-labelledby="interrupted-uploads" className="border-b last:border-0">
          <p id="interrupted-uploads" className="px-4 pt-3 text-xs font-medium text-muted-foreground">Interrupted uploads</p>
          {interrupted.map((upload) => <div key={upload.id} className="flex items-start gap-3 px-4 py-3">
            <History className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <TruncatedText as="p" className="text-sm">{upload.name}</TruncatedText>
              <p className="break-words text-xs text-muted-foreground">{formatBytes(upload.size)} · {upload.parentName ?? "All files"}</p>
              {upload.error && <p role="alert" className="break-words text-xs text-destructive">{upload.error}</p>}
              <div className="flex gap-2">
                <Button variant="outline" size="xs" disabled={upload.discarding} aria-label={`Resume upload of ${upload.name}`} onClick={() => void resume(upload)}>Resume</Button>
                <Button variant="ghost" size="xs" disabled={upload.discarding} aria-label={`Discard upload of ${upload.name}`} onClick={() => void discard(upload)}>{upload.discarding && <Spinner size={12} label="Discarding" />}Discard</Button>
              </div>
            </div>
          </div>)}
        </div>}
        {preparations.map((preparation) => <div key={preparation.key} className="flex items-start gap-3 border-b px-4 py-3 last:border-0">
          <FolderUp className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <TruncatedText as="p" className="text-sm">{preparation.name}</TruncatedText>
            <p role={preparation.status === "error" ? "alert" : undefined} className={preparation.status === "error" ? "break-words text-xs text-destructive" : "break-words text-xs text-muted-foreground"}>{preparation.message}</p>
          </div>
          {preparation.status === "preparing" && <Button variant="ghost" size="icon-sm" aria-label={`Cancel upload of ${preparation.name}`} onClick={() => cancel(preparation.key)}><X /></Button>}
          {preparation.status === "complete" && <Check className="mt-0.5 size-4 text-primary" aria-label="Folders prepared" />}
        </div>)}
        {jobs.map((job) => <div key={job.key} className="flex items-start gap-3 border-b px-4 py-3 last:border-0">
          <Upload className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <TruncatedText as="p" className="text-sm">{job.file.name}</TruncatedText>
            {(job.status === "uploading" || job.status === "saving") && <Progress size="sm" value={job.progress} aria-label={`Uploading ${job.file.name}`} />}
            <p className={job.status === "error" ? "break-words text-xs tabular-nums text-destructive" : "break-words text-xs tabular-nums text-muted-foreground"}>
              {job.status === "uploading" ? <>
                <span>{job.progress}% of {formatBytes(job.file.size)}</span>
                {job.bytesPerSecond !== null && <span> · {formatBytes(Math.round(job.bytesPerSecond))}/s</span>}
              </> : jobStatusText(job)}
            </p>
          </div>
          {["checking", "conflict", "queued", "preparing", "uploading"].includes(job.status) && <Button variant="ghost" size="icon-sm" aria-label={`Cancel upload of ${job.file.name}`} onClick={() => cancel(job.key)}><X /></Button>}
          {job.status === "complete" && <Check className="mt-0.5 size-4 text-primary" aria-label="Complete" />}
        </div>)}
      </div>}
    </section>
  );
}
