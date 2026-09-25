import { ZipWriter } from "@zip.js/zip.js";
import type { ArchivePlan } from "./archive-paths";

export type ArchiveProgress = {
  phase: "connecting" | "downloading" | "finalizing";
  currentPath: string;
  completedFiles: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes: number;
};

type ArchiveDownloadOptions = {
  plan: ArchivePlan;
  getDownloadUrl: (id: string, signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
  onProgress: (progress: ArchiveProgress) => void;
};

type BrowserArchiveSink = {
  writable: WritableStream<Uint8Array>;
  finished: Promise<void>;
  dispose: () => void;
};

const chunkBytes = 256 * 1024;

/** Server actions are not abortable, but a cancelled job must never resume them. */
export function waitForArchiveOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function activeDownloadWorker(signal: AbortSignal) {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    throw new Error("This browser cannot stream ZIP downloads. Open the drive in a current version of Chrome, Edge, Firefox, or Safari over HTTPS.");
  }
  const registration = await waitForArchiveOperation(navigator.serviceWorker.register("/drive-download-worker.js", {
    scope: "/drive-download/",
    updateViaCache: "none",
  }), signal);
  const worker = registration.active ?? registration.installing ?? registration.waiting;
  if (!worker) throw new Error("The download helper could not start. Reload the page and try again.");
  if (worker.state !== "activated") {
    await waitForArchiveOperation(new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => finish(new Error("The download helper did not start. Reload the page and try again.")), 30_000);
      function finish(error?: Error) {
        window.clearTimeout(timer);
        worker!.removeEventListener("statechange", changed);
        signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      }
      function changed() {
        if (worker!.state === "activated") finish();
        else if (worker!.state === "redundant") finish(new Error("The download helper was replaced. Try the download again."));
      }
      function aborted() { finish(signal.reason); }
      worker.addEventListener("statechange", changed);
      signal.addEventListener("abort", aborted, { once: true });
      changed();
    }), signal);
  }
  signal.throwIfAborted();
  return worker;
}

/** Transferable streams propagate browser download backpressure all the way to R2. */
async function openBrowserArchive(filename: string, controller: AbortController): Promise<BrowserArchiveSink> {
  const { signal } = controller;
  const worker = await activeDownloadWorker(signal);
  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  let streamController: TransformStreamDefaultController<Uint8Array>;
  const bridge = new TransformStream<Uint8Array, Uint8Array>({
    start(value) { streamController = value; },
  }, { highWaterMark: 1 }, { highWaterMark: 0 });
  const writer = bridge.writable.getWriter();
  // Observe early browser-side cancellation, even while waiting on an unlock dialog.
  void writer.closed.catch((error: unknown) => { if (!signal.aborted) controller.abort(error); });
  let resolveReady: () => void;
  let rejectReady: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  let resolveFinished: () => void;
  let rejectFinished: (reason: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
  // Completion can reject before the caller reaches its final await.
  void finished.catch(() => {});
  let disposed = false;
  let completed = false;
  let frame: HTMLIFrameElement | undefined;
  let heartbeat: number | undefined;
  let watchdog: number | undefined;
  let startTimer: number | undefined;

  function dispose() {
    if (disposed) return;
    disposed = true;
    window.clearInterval(heartbeat);
    window.clearTimeout(watchdog);
    window.clearTimeout(startTimer);
    signal.removeEventListener("abort", aborted);
    channel.port1.close();
    frame?.remove();
  }
  function aborted() {
    if (completed) return;
    const reason: unknown = signal.reason ?? new DOMException("Download cancelled", "AbortError");
    streamController.error(reason);
    try { worker.postMessage({ type: "orole-archive-abort", id }); } catch { /* The worker may already have stopped. */ }
    rejectReady(reason);
    rejectFinished(reason);
    dispose();
  }
  function resetWatchdog() {
    window.clearTimeout(watchdog);
    watchdog = window.setTimeout(() => controller.abort(new Error("The browser download connection was lost. Discard the incomplete ZIP and try again.")), 120_000);
  }
  channel.port1.onmessage = (event: MessageEvent<{ type: string; message?: string }>) => {
    if (disposed) return;
    resetWatchdog();
    switch (event.data.type) {
      case "ready": resolveReady(); break;
      case "started": window.clearTimeout(startTimer); break;
      case "done":
        completed = true;
        resolveFinished();
        break;
      case "cancelled": controller.abort(new DOMException("The browser cancelled the download.", "AbortError")); break;
      case "error": controller.abort(new Error(event.data.message ?? "The browser could not finish the ZIP download.")); break;
    }
  };
  channel.port1.onmessageerror = () => controller.abort(new Error("The browser could not receive the ZIP stream."));
  signal.addEventListener("abort", aborted, { once: true });
  try {
    signal.throwIfAborted();
    worker.postMessage({ type: "orole-archive-open", id, filename, stream: bridge.readable }, [channel.port2, bridge.readable]);
    resetWatchdog();
    startTimer = window.setTimeout(() => controller.abort(new Error("The browser did not start the download. Allow downloads for this site, then try again.")), 30_000);
    // Messages to the ServiceWorker (not just its port) keep long/background downloads alive.
    heartbeat = window.setInterval(() => {
      try { worker.postMessage({ type: "orole-archive-ping", id }); }
      catch { controller.abort(new Error("The download helper stopped. Try the download again.")); }
    }, 20_000);
    await ready;
    signal.throwIfAborted();
    frame = document.createElement("iframe");
    frame.hidden = true;
    frame.title = "ZIP download";
    frame.src = `/drive-download/${id}/${encodeURIComponent(filename)}`;
    document.body.appendChild(frame);
    const writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        for (let offset = 0; offset < chunk.byteLength; offset += chunkBytes) {
          signal.throwIfAborted();
          await writer.write(chunk.subarray(offset, Math.min(offset + chunkBytes, chunk.byteLength)));
        }
      },
      close() { return writer.close(); },
      abort(reason) { controller.abort(reason); },
    }, { highWaterMark: 1 });
    return { writable, finished, dispose };
  } catch (error) {
    if (!signal.aborted) {
      controller.abort(error instanceof DOMException && error.name === "DataCloneError"
        ? new Error("This browser cannot stream large ZIP downloads. Try the latest Chrome or Edge; no files were changed.")
        : error);
    }
    dispose();
    throw signal.reason;
  }
}

export async function downloadArchive({ plan, getDownloadUrl, signal: externalSignal, onProgress }: ArchiveDownloadOptions) {
  const controller = new AbortController();
  const { signal } = controller;
  const abort = () => controller.abort(externalSignal.reason);
  externalSignal.addEventListener("abort", abort, { once: true });
  if (externalSignal.aborted) abort();
  let sink: BrowserArchiveSink | undefined;
  const progress: ArchiveProgress = {
    phase: "connecting", currentPath: "", completedFiles: 0, totalFiles: plan.totalFiles,
    downloadedBytes: 0, totalBytes: plan.totalBytes,
  };
  let lastProgress = 0;
  try {
    signal.throwIfAborted();
    onProgress({ ...progress });
    sink = await openBrowserArchive(plan.filename, controller);
    const zip = new ZipWriter(sink.writable, {
      zip64: true, level: 0, bufferedWrite: false, dataDescriptor: true,
      useWebWorkers: false, useUnicodeFileNames: true, signal,
    });
    for (const { item, path } of plan.entries) {
      signal.throwIfAborted();
      progress.currentPath = path;
      progress.phase = "downloading";
      onProgress({ ...progress });
      if (item.kind === "folder") {
        await zip.add(path, undefined, { directory: true });
        continue;
      }
      // Sign each file immediately before fetching; URLs expire in one minute.
      const url = await waitForArchiveOperation(getDownloadUrl(item.id, signal), signal);
      signal.throwIfAborted();
      const response = await fetch(url, { signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`“${item.name}” could not be downloaded. Discard the incomplete ZIP and try again.`);
      }
      let fileBytes = 0;
      const measured = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, output) {
          fileBytes += chunk.byteLength;
          if (fileBytes > item.size) throw new Error(`“${item.name}” changed during download. Discard the incomplete ZIP and try again.`);
          progress.downloadedBytes += chunk.byteLength;
          const now = performance.now();
          if (now - lastProgress >= 150) {
            lastProgress = now;
            onProgress({ ...progress });
          }
          output.enqueue(chunk);
        },
        flush() {
          if (fileBytes !== item.size) throw new Error(`“${item.name}” was incomplete. Discard the incomplete ZIP and try again.`);
        },
      }), { signal });
      await zip.add(path, measured);
      progress.completedFiles++;
      onProgress({ ...progress });
    }
    signal.throwIfAborted();
    progress.phase = "finalizing";
    progress.currentPath = "";
    onProgress({ ...progress });
    await zip.close(undefined, { zip64: true });
    await sink.finished;
    signal.throwIfAborted();
  } catch (error) {
    if (!signal.aborted) controller.abort(error);
    // Never close a failed ZIP: its partial output must remain a failed download.
    throw signal.reason;
  } finally {
    externalSignal.removeEventListener("abort", abort);
    sink?.dispose();
  }
}
