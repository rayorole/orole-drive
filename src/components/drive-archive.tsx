"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Archive, Check, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { getArchiveManifest, getDownloadUrl } from "@/app/actions/drive";
import { downloadArchive, waitForArchiveOperation } from "@/lib/archive-download";
import type { ArchiveProgress } from "@/lib/archive-download";
import type { DriveArchiveManifest } from "@/lib/drive-types";
import { planArchive } from "@/lib/archive-paths";
import { useFolderAccess } from "@/components/folder-access";
import { formatBytes } from "@/lib/format-bytes";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TruncatedText } from "@/components/hint";

type ArchiveState = {
  status: "preparing" | "working" | "complete" | "cancelled" | "error";
  ids: string[];
  filename: string;
  progress: ArchiveProgress | null;
  error: string | null;
};

type ArchiveDownloadHook = { start: (ids: string[]) => void; isPending: boolean; dialog: ReactNode };

/** Where an archive's manifest and per-file URLs come from: the signed-in drive or a public folder link. */
export type ArchiveSource = {
  getManifest: (ids: string[], signal: AbortSignal) => Promise<DriveArchiveManifest>;
  getDownloadUrl: (id: string, signal: AbortSignal) => Promise<string>;
};

export function useArchiveDownload(): ArchiveDownloadHook {
  const { run } = useFolderAccess();
  const source = useMemo<ArchiveSource>(() => ({
    // Checked inside `run`: an unlock prompt can resolve after the download was cancelled.
    getManifest: (ids, signal) => run(() => {
      signal.throwIfAborted();
      return getArchiveManifest(ids);
    }),
    getDownloadUrl: async (id, signal) => {
      const result = await run(() => {
        signal.throwIfAborted();
        return getDownloadUrl(id);
      });
      return result.url;
    },
  }), [run]);
  return useArchiveDownloader(source);
}

export function useArchiveDownloader(source: ArchiveSource): ArchiveDownloadHook {
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<ArchiveState | null>(null);
  const isPending = state?.status === "preparing" || state?.status === "working";

  useEffect(() => {
    function leave(event: BeforeUnloadEvent) {
      if (!active.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function stop() {
      const controller = active.current;
      active.current = null;
      controller?.abort(new DOMException("The drive tab was closed.", "AbortError"));
    }
    function hide() {
      if (active.current) setState((current) => current && { ...current, status: "cancelled", error: null });
      stop();
    }
    window.addEventListener("beforeunload", leave);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("pagehide", hide);
      stop();
    };
  }, []);

  const start = useCallback((ids: string[]) => {
    if (active.current || !ids.length) return;
    const controller = new AbortController();
    active.current = controller;
    const selected = [...new Set(ids)];
    setState({ status: "preparing", ids: selected, filename: "", progress: null, error: null });
    void (async () => {
      try {
        const manifest = await waitForArchiveOperation(source.getManifest(selected, controller.signal), controller.signal);
        controller.signal.throwIfAborted();
        const plan = planArchive(manifest);
        setState((current) => current && { ...current, status: "working", filename: plan.filename });
        await downloadArchive({
          plan,
          signal: controller.signal,
          getDownloadUrl: source.getDownloadUrl,
          onProgress: (progress) => {
            if (active.current === controller) setState((current) => current && { ...current, progress });
          },
        });
        if (active.current !== controller) return;
        setState((current) => current && { ...current, status: "complete" });
        toast.success("ZIP sent to your browser");
      } catch (error) {
        if (active.current !== controller) return;
        const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        const message = error instanceof Error ? error.message : "The archive could not be downloaded. Try again.";
        setState((current) => current && { ...current, status: cancelled ? "cancelled" : "error", error: cancelled ? null : message });
        if (!cancelled) toast.error("ZIP download stopped", { description: message });
      } finally {
        if (active.current === controller) active.current = null;
      }
    })();
  }, [source]);

  const progress = state?.progress;
  const fraction = progress && progress.totalBytes > 0 ? progress.downloadedBytes / progress.totalBytes : null;
  const statusText = state?.status === "preparing" ? "Checking files and folder access…"
    : progress?.phase === "connecting" ? "Connecting to your browser…"
      : progress?.phase === "finalizing" ? "Finishing the ZIP…"
        : "Downloading files…";
  const dialog = state ? <Dialog open onOpenChange={(open) => { if (!open && !active.current) setState(null); }}>
    <DialogContent showCloseButton={!isPending}>
      <DialogHeader>
        <DialogTitle>{isPending ? "Download as ZIP" : state.status === "complete" ? "ZIP sent to your browser" : state.status === "cancelled" ? "ZIP download cancelled" : "ZIP download stopped"}</DialogTitle>
        <DialogDescription>{isPending ? "Keep this tab open while your files stream directly to your browser. Large archives do not need to fit in memory." : state.status === "complete" ? "Check your browser’s downloads for the saved ZIP. You can now close this dialog." : "Your files in the drive have not changed. Discard any incomplete ZIP in your downloads."}</DialogDescription>
      </DialogHeader>
      {isPending ? <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center gap-2 text-sm"><Spinner label={statusText} /><span aria-hidden="true">{statusText}</span></div>
        {state.filename && <TruncatedText as="p" className="text-sm font-medium">{state.filename}</TruncatedText>}
        {progress && <>
          <progress aria-label="Archive download progress" max={1} value={fraction ?? undefined} className="h-2 w-full accent-primary" />
          <div className="flex flex-wrap justify-between gap-1 text-xs tabular-nums text-muted-foreground">
            <span>{progress.completedFiles} of {progress.totalFiles} files</span>
            <span>{formatBytes(progress.downloadedBytes)} of {formatBytes(progress.totalBytes)}</span>
          </div>
          {progress.currentPath && <TruncatedText as="p" className="text-xs text-muted-foreground">{progress.currentPath}</TruncatedText>}
        </>}
      </div> : state.status === "error" ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>Could not finish the archive</AlertTitle><AlertDescription>{state.error}</AlertDescription></Alert>
        : <div className="flex min-w-0 items-center gap-2 text-sm">{state.status === "complete" ? <Check className="size-4 shrink-0" aria-hidden="true" /> : <Archive className="size-4 shrink-0" aria-hidden="true" />}<TruncatedText>{state.filename || "No archive was saved."}</TruncatedText></div>}
      <DialogFooter>
        {isPending ? <Button variant="outline" onClick={() => active.current?.abort(new DOMException("Download cancelled", "AbortError"))}>Cancel download</Button> : <>
          <Button variant="outline" onClick={() => setState(null)}>Close</Button>
          {state.status !== "complete" && <Button onClick={() => start(state.ids)}>Try again</Button>}
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog> : null;

  return { start, isPending, dialog };
}
