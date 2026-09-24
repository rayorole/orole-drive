"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, CircleAlert, Upload, X } from "lucide-react";
import { beginUpload, cancelUpload, completeUpload } from "@/app/actions/drive";
import { MAX_UPLOAD_BYTES } from "@/lib/drive-types";
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
  error?: string;
  uploadId?: string;
  xhr?: XMLHttpRequest;
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
    job.status = "preparing";
    publish();
    try {
      const ticket = await beginUpload({ name: job.file.name, size: job.file.size, mimeType: job.file.type || "application/octet-stream", parentId: job.parentId });
      if (!ticket.success) throw new Error(ticket.error);
      job.uploadId = ticket.data.id;
      if (job.cancelled) throw new Error("Upload cancelled.");
      job.status = "uploading";
      publish();
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        job.xhr = xhr;
        xhr.open("PUT", ticket.data.url);
        for (const [header, value] of Object.entries(ticket.data.headers)) xhr.setRequestHeader(header, value);
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable || job.cancelled) return;
          job.progress = Math.round((event.loaded / event.total) * 100);
          publish();
        };
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage rejected the upload (${xhr.status}). Try again.`));
        xhr.onerror = () => reject(new Error("Upload interrupted. Check your connection and try again."));
        xhr.onabort = () => reject(new Error("Upload cancelled."));
        xhr.send(job.file);
      });
      if (job.cancelled) throw new Error("Upload cancelled.");
      job.xhr = undefined;
      job.status = "saving";
      job.progress = 100;
      publish();
      const result = await completeUpload(job.uploadId);
      if (!result.success) throw new Error(result.error);
      job.status = "complete";
      void queryClient.invalidateQueries({ queryKey: ["drive"] });
    } catch (error) {
      job.status = job.cancelled ? "cancelled" : "error";
      job.error = error instanceof Error ? error.message : "Could not upload this file. Try again.";
      if (job.uploadId) {
        try {
          const result = await cancelUpload(job.uploadId);
          if (!result.success) job.error = `${job.error} Temporary upload cleanup failed: ${result.error}`;
        } catch {
          job.error = `${job.error} Temporary upload cleanup could not finish.`;
        }
      }
    } finally {
      job.xhr = undefined;
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

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const job of jobsRef.current) {
        if (job.status === "queued" || job.status === "preparing" || job.status === "uploading") {
          job.cancelled = true;
          job.xhr?.abort();
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
      key: crypto.randomUUID(), file, parentId, cancelled: false, progress: 0,
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
    job.xhr?.abort();
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
    <section aria-label="File uploads" className="fixed bottom-4 right-4 z-30 w-[calc(100%-2rem)] overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-lg sm:w-96">
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
            <p className={job.status === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {job.status === "queued" ? "Waiting to upload" : job.status === "preparing" ? "Preparing upload…" : job.status === "uploading" ? `${job.progress}% of ${formatBytes(job.file.size)}` : job.status === "saving" ? "Finishing…" : job.status === "complete" ? "Uploaded" : job.status === "cancelled" ? "Cancelled" : job.error}
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
