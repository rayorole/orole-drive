"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, CircleAlert, Upload, X } from "lucide-react";
import { beginUpload, cancelUpload, completeUpload } from "@/app/actions/drive";
import { MAX_UPLOAD_BYTES } from "@/lib/drive-types";
import { transferUpload } from "@/lib/upload-transfer";
import { UploadRate } from "@/lib/upload-rate";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/cubby-ui/progress";
import { Spinner } from "@/components/spinner";
import { formatBytes } from "@/components/drive-item";

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

export type DriveUploads = {
  jobs: UploadJob[];
  pending: number;
  addFiles: (files: File[], parentId: string | null) => void;
  cancel: (key: string) => void;
  clearFinished: () => void;
};

export function useDriveUploads(): DriveUploads {
  const queryClient = useQueryClient();
  const jobsRef = useRef<UploadJob[]>([]);
  const running = useRef(0);
  const mounted = useRef(true);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const publish = useCallback(() => {
    if (mounted.current) setJobs(jobsRef.current.map((job) => ({ ...job })));
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
      const ticket = await beginUpload({ name: job.file.name, size: job.file.size, mimeType: job.file.type || "application/octet-stream", parentId: job.parentId });
      if (!ticket.success) throw new Error(ticket.error);
      job.uploadId = ticket.data.id;
      controller.signal.throwIfAborted();
      job.status = "uploading";
      job.rate = new UploadRate();
      publish();
      await transferUpload(job.file, ticket.data, controller.signal, (bytes) => {
        job.uploadedBytes = bytes;
      });
      controller.signal.throwIfAborted();
      stopProgress();
      job.status = "saving";
      job.progress = 100;
      publish();
      const result = await completeUpload(job.uploadId);
      if (!result.success) throw new Error(result.error);
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
  }, [publish, queryClient]);

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

  const pending = jobs.filter((job) => ["queued", "preparing", "uploading", "saving"].includes(job.status)).length;
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const addFiles = useCallback((files: File[], parentId: string | null) => {
    jobsRef.current.push(...files.map((file): UploadJob => ({
      key: crypto.randomUUID(), file, parentId, cancelled: false, progress: 0, uploadedBytes: 0, bytesPerSecond: null,
      status: file.size > MAX_UPLOAD_BYTES ? "error" : "queued",
      error: file.size > MAX_UPLOAD_BYTES ? `This file exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.` : undefined,
    })));
    publish();
  }, [publish]);

  const cancel = useCallback((key: string) => {
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
    jobsRef.current = jobsRef.current.filter((job) => ["queued", "preparing", "uploading", "saving"].includes(job.status));
    publish();
  }, [publish]);

  return { jobs, pending, addFiles, cancel, clearFinished };
}

export function DriveUploadQueue({ uploads }: { uploads: DriveUploads }) {
  const [collapsed, setCollapsed] = useState(false);
  const { jobs, pending, cancel, clearFinished } = uploads;
  if (!jobs.length) return null;
  const errors = jobs.filter((job) => job.status === "error").length;
  return (
    <section aria-label="File uploads" className="notification-surface fixed bottom-4 right-4 z-30 w-[calc(100%-2rem)] overflow-hidden sm:w-96">
      <div className="flex items-center gap-2 px-4 py-3">
        {pending ? <Spinner /> : errors ? <CircleAlert className="size-4 text-destructive" /> : <Check className="size-4 text-primary" />}
        <p className="min-w-0 flex-1 text-sm font-medium" aria-live="polite">
          {pending ? `Uploading ${pending} ${pending === 1 ? "file" : "files"}` : errors ? `${errors} ${errors === 1 ? "upload needs" : "uploads need"} attention` : "Uploads finished"}
        </p>
        <Button variant="ghost" size="icon-sm" aria-expanded={!collapsed} aria-controls="upload-jobs" aria-label={collapsed ? "Expand uploads" : "Collapse uploads"} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronUp /> : <ChevronDown />}</Button>
        {!pending && <Button variant="ghost" size="icon-sm" aria-label="Dismiss upload queue" onClick={clearFinished}><X /></Button>}
      </div>
      {!collapsed && <div id="upload-jobs" className="max-h-72 overflow-y-auto border-t">
        {jobs.map((job) => <div key={job.key} className="flex items-start gap-3 border-b px-4 py-3 last:border-0">
          <Upload className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className="truncate text-sm" title={job.file.name}>{job.file.name}</p>
            {(job.status === "uploading" || job.status === "saving") && <Progress size="sm" value={job.progress} aria-label={`Uploading ${job.file.name}`} />}
            <p className={job.status === "error" ? "break-words text-xs tabular-nums text-destructive" : "break-words text-xs tabular-nums text-muted-foreground"}>
              {job.status === "queued" ? "Waiting to upload" : job.status === "preparing" ? "Preparing upload…" : job.status === "uploading" ? <>
                <span>{job.progress}% of {formatBytes(job.file.size)}</span>{" "}
                <span className="inline-block">· {job.bytesPerSecond === null ? "Measuring speed…" : `${formatBytes(Math.round(job.bytesPerSecond))}/s`}</span>
              </> : job.status === "saving" ? "Finishing…" : job.status === "complete" ? "Uploaded" : job.status === "cancelled" ? "Cancelled" : job.error}
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
