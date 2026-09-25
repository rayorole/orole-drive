"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, CircleAlert, FolderUp, Upload, X } from "lucide-react";
import { beginUpload, cancelUpload, completeUpload, createFolder } from "@/app/actions/drive";
import { MAX_UPLOAD_BYTES } from "@/lib/drive-types";
import { transferUpload } from "@/lib/upload-transfer";
import { UploadRate } from "@/lib/upload-rate";
import { chooseDirectoryFiles, snapshotDataTransfer, treeFromDirectoryHandle, treeFromDrop, treeFromRelativeFiles } from "@/lib/directory-upload";
import type { UploadDirectoryHandle, UploadTreeNode } from "@/lib/directory-upload";
import { useFolderAccess } from "@/components/folder-access";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/cubby-ui/progress";
import { Spinner } from "@/components/spinner";
import { formatBytes } from "@/components/drive-item";
import { TruncatedText } from "@/components/hint";

type UploadStatus = "queued" | "preparing" | "uploading" | "saving" | "complete" | "cancelled" | "error";
type UploadJob = {
  key: string;
  file: File;
  parentId: string | null;
  status: UploadStatus;
  progress: number;
  uploadedBytes: number;
  bytesPerSecond: number | null;
  rate?: UploadRate;
  error?: string;
  uploadId?: string;
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

function isPreparationPending(preparation: FolderPreparation) {
  return preparation.status === "preparing" || preparation.status === "cancelling";
}

function isUploadPending(job: UploadJob) {
  return !!job.controller || ["queued", "preparing", "uploading", "saving"].includes(job.status);
}

function createUploadJob(file: File, parentId: string | null): UploadJob {
  return {
    key: crypto.randomUUID(), file, parentId, cancelled: false, progress: 0, uploadedBytes: 0, bytesPerSecond: null,
    status: file.size > MAX_UPLOAD_BYTES ? "error" : "queued",
    error: file.size > MAX_UPLOAD_BYTES ? `This file exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.` : undefined,
  };
}

export type DriveUploads = {
  jobs: UploadJob[];
  preparations: FolderPreparation[];
  pending: number;
  addFiles: (files: File[], parentId: string | null) => void;
  addFolderFiles: (files: File[], parentId: string | null) => void;
  addDrop: (transfer: DataTransfer, parentId: string | null) => void;
  chooseFolder: (parentId: string | null) => void;
  cancel: (key: string) => void;
  clearFinished: () => void;
};

export function useDriveUploads(): DriveUploads {
  const queryClient = useQueryClient();
  const access = useFolderAccess();
  const preparationsRef = useRef<FolderPreparation[]>([]);
  const [preparations, setPreparations] = useState<FolderPreparation[]>([]);
  const jobsRef = useRef<UploadJob[]>([]);
  const running = useRef(0);
  const mounted = useRef(true);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const publish = useCallback(() => {
    if (mounted.current) {
      setJobs(jobsRef.current.map((job) => ({ ...job })));
      setPreparations(preparationsRef.current.map((preparation) => ({ ...preparation })));
    }
  }, []);

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
      const ticket = await access.run(() => {
        controller.signal.throwIfAborted();
        return beginUpload({ name: job.file.name, size: job.file.size, mimeType: job.file.type || "application/octet-stream", parentId: job.parentId });
      });
      job.uploadId = ticket.id;
      controller.signal.throwIfAborted();
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
      await access.run(() => completeUpload(ticket.id));
      job.status = "complete";
      void queryClient.invalidateQueries({ queryKey: ["drive"] });
    } catch (error) {
      controller.abort();
      stopProgress();
      job.status = job.cancelled ? "cancelled" : "error";
      job.error = job.cancelled ? "Upload cancelled." : error instanceof Error ? error.message : "Could not upload this file. Try again.";
      publish();
      if (job.uploadId) {
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
    }
  }, [access, publish, queryClient]);

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
        job.bytesPerSecond = job.rate.sample(job.uploadedBytes);
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
        if (job.status === "queued" || job.status === "preparing" || job.status === "uploading") {
          job.cancelled = true;
          job.status = "cancelled";
          job.bytesPerSecond = null;
          job.rate = undefined;
          job.controller?.abort();
        }
      }
    };
  }, []);

  const pending = jobs.filter(isUploadPending).length + preparations.filter(isPreparationPending).length;
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const addFiles = useCallback((files: File[], parentId: string | null) => {
    for (const file of files) jobsRef.current.push(createUploadJob(file, parentId));
    publish();
  }, [publish]);

  const prepare = useCallback((name: string, parentId: string | null, readTree: (signal: AbortSignal) => Promise<UploadTreeNode[]>) => {
    const preparation: FolderPreparation = {
      key: crypto.randomUUID(), name, status: "preparing", controller: new AbortController(),
      foldersCreated: 0, filesQueued: 0, message: "Reading folders…",
    };
    preparationsRef.current.push(preparation);
    publish();
    const signal = preparation.controller.signal;
    void (async () => {
      try {
        const roots = await readTree(signal);
        signal.throwIfAborted();
        if (!roots.length) {
          preparation.status = "cancelled";
          preparation.message = "No files or folders were selected.";
          return;
        }
        const files: { file: File; parentId: string | null }[] = [];
        const createTree = async (nodes: UploadTreeNode[], destination: string | null): Promise<void> => {
          for (const node of nodes) {
            signal.throwIfAborted();
            if (node.kind === "file") {
              files.push({ file: node.file, parentId: destination });
              continue;
            }
            preparation.message = `Creating folders… ${preparation.foldersCreated} created`;
            publish();
            const folder = await access.run(() => {
              signal.throwIfAborted();
              return createFolder({ name: node.name, parentId: destination });
            });
            preparation.foldersCreated += 1;
            signal.throwIfAborted();
            await createTree(node.children, folder.id);
          }
        };
        await createTree(roots, parentId);
        signal.throwIfAborted();
        // Only queue files once their entire destination hierarchy exists.
        for (const file of files) jobsRef.current.push(createUploadJob(file.file, file.parentId));
        preparation.filesQueued = files.length;
        preparation.status = "complete";
        preparation.message = `${preparation.foldersCreated} ${preparation.foldersCreated === 1 ? "folder" : "folders"} created · ${files.length} ${files.length === 1 ? "file" : "files"} added to the queue`;
      } catch (error) {
        const cancelled = signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        preparation.status = cancelled ? "cancelled" : "error";
        const reason = cancelled ? "Folder upload cancelled." : error instanceof Error ? error.message : "Could not read this folder. Choose it again.";
        preparation.message = `${reason}${preparation.foldersCreated ? ` ${preparation.foldersCreated} created folders remain in Drive; no files were queued.` : ""}`;
      } finally {
        if (preparation.foldersCreated) void queryClient.invalidateQueries({ queryKey: ["drive"] });
        publish();
      }
    })();
  }, [access, publish, queryClient]);

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
      preparation.message = "Cancelling… Waiting for the current operation to finish.";
      preparation.controller.abort();
      publish();
      return;
    }
    const job = jobsRef.current.find((entry) => entry.key === key);
    if (!job || !["queued", "preparing", "uploading"].includes(job.status)) return;
    job.cancelled = true;
    job.status = "cancelled";
    job.bytesPerSecond = null;
    job.rate = undefined;
    job.controller?.abort();
    publish();
  }, [publish]);

  const clearFinished = useCallback(() => {
    jobsRef.current = jobsRef.current.filter(isUploadPending);
    preparationsRef.current = preparationsRef.current.filter(isPreparationPending);
    publish();
  }, [publish]);

  return { jobs, preparations, pending, addFiles, addFolderFiles, addDrop, chooseFolder, cancel, clearFinished };
}

export function DriveUploadQueue({ uploads }: { uploads: DriveUploads }) {
  const [collapsed, setCollapsed] = useState(false);
  const { jobs, preparations, pending, cancel, clearFinished } = uploads;
  if (!jobs.length && !preparations.length) return null;
  const preparing = preparations.filter(isPreparationPending).length;
  const errors = jobs.filter((job) => job.status === "error").length + preparations.filter((preparation) => preparation.status === "error").length;
  return (
    <section aria-label="File uploads" className="notification-surface fixed bottom-4 right-4 z-30 w-[calc(100%-2rem)] overflow-hidden sm:w-96">
      <div className="flex items-center gap-2 px-4 py-3">
        {pending ? <Spinner /> : errors ? <CircleAlert className="size-4 text-destructive" /> : <Check className="size-4 text-primary" />}
        <p className="min-w-0 flex-1 text-sm font-medium" aria-live="polite">
          {pending ? preparing ? "Preparing folder uploads…" : `Uploading ${pending} ${pending === 1 ? "file" : "files"}` : errors ? `${errors} ${errors === 1 ? "upload needs" : "uploads need"} attention` : "Uploads finished"}
        </p>
        <Button variant="ghost" size="icon-sm" aria-expanded={!collapsed} aria-controls="upload-jobs" aria-label={collapsed ? "Expand uploads" : "Collapse uploads"} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronUp /> : <ChevronDown />}</Button>
        {!pending && <Button variant="ghost" size="icon-sm" aria-label="Dismiss upload queue" onClick={clearFinished}><X /></Button>}
      </div>
      {!collapsed && <div id="upload-jobs" className="max-h-72 overflow-y-auto border-t">
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
              {job.status === "queued" ? "Waiting to upload" : job.status === "preparing" ? "Preparing upload…" : job.status === "uploading" ? <>
                <span>{job.progress}% of {formatBytes(job.file.size)}</span>{" "}
                <span className="inline-block">· {job.bytesPerSecond === null ? "Measuring speed…" : `${formatBytes(Math.round(job.bytesPerSecond))}/s`}</span>
              </> : job.status === "saving" ? "Finishing…" : job.status === "complete" ? "Uploaded" : job.status === "cancelled" ? job.controller ? "Cancelling…" : job.error || "Cancelled" : job.error}
            </p>
          </div>
          {["queued", "preparing", "uploading"].includes(job.status) && <Button variant="ghost" size="icon-sm" aria-label={`Cancel upload of ${job.file.name}`} onClick={() => cancel(job.key)}><X /></Button>}
          {job.status === "complete" && <Check className="mt-0.5 size-4 text-primary" aria-label="Complete" />}
        </div>)}
        {pending > 0 && <p className="px-4 py-3 text-xs text-muted-foreground">Keep this tab open until your uploads finish.</p>}
      </div>}
    </section>
  );
}
