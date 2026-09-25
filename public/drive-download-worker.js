/* The scope is /drive-download/ only; this worker never intercepts app or R2 requests. */
const downloads = new Map();
const prefix = "/drive-download/";

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function endDownload(download, type, message) {
  if (download.finished) return;
  download.finished = true;
  clearTimeout(download.expiry);
  downloads.delete(download.id);
  download.port.postMessage({ type, message });
  download.port.close();
}

function failDownload(download, type, message) {
  if (download.finished) return;
  const error = new Error(message);
  download.controller?.error(error);
  void download.reader.cancel(error).catch(() => {});
  endDownload(download, type, message);
}

function keepAlive(download) {
  clearTimeout(download.expiry);
  // No overall archive time limit. Expire only abandoned producer connections.
  download.expiry = setTimeout(() => failDownload(download, "error", "The drive tab disconnected. Discard the incomplete ZIP and try again."), 120_000);
}

self.addEventListener("message", (event) => {
  const source = event.source;
  if (!source || !("url" in source) || new URL(source.url).origin !== self.location.origin) return;
  const data = event.data;
  if (!data || typeof data.id !== "string" || !/^[0-9a-f-]{36}$/i.test(data.id)) return;
  const existing = downloads.get(data.id);
  if (data.type === "orole-archive-ping" || data.type === "orole-archive-abort") {
    if (!existing || existing.clientId !== source.id) return;
    if (data.type === "orole-archive-abort") failDownload(existing, "cancelled", "Download cancelled.");
    else {
      keepAlive(existing);
      existing.port.postMessage({ type: "pong" });
    }
    return;
  }
  if (data.type !== "orole-archive-open" || existing) return;
  const port = event.ports[0];
  if (!port) return;
  if (!(data.stream instanceof ReadableStream) || typeof data.filename !== "string") {
    port.postMessage({ type: "error", message: "The browser cannot receive the ZIP stream." });
    port.close();
    return;
  }
  const download = {
    id: data.id,
    clientId: source.id,
    // eslint-disable-next-line no-control-regex -- Attachment headers cannot contain control characters.
    filename: data.filename.slice(0, 255).replace(/["/\\\u0000-\u001f\u007f\ud800-\udfff]/gu, "_"),
    reader: data.stream.getReader(),
    port,
    started: false,
    finished: false,
    controller: null,
    expiry: null,
  };
  downloads.set(data.id, download);
  keepAlive(download);
  port.postMessage({ type: "ready" });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
  const id = url.pathname.slice(prefix.length).split("/")[0];
  const download = downloads.get(id);
  if (event.request.method !== "GET" || !download || download.started) {
    event.respondWith(new Response("This download is no longer available. Start it again from the drive.", {
      status: 410, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    }));
    return;
  }
  download.started = true;
  keepAlive(download);
  const stream = new ReadableStream({
    start(controller) {
      download.controller = controller;
    },
    async pull(controller) {
      try {
        const { value, done } = await download.reader.read();
        if (download.finished) return;
        keepAlive(download);
        if (done) {
          controller.close();
          endDownload(download, "done");
        } else {
          controller.enqueue(value);
        }
      } catch {
        failDownload(download, "error", "The ZIP stream was interrupted. Discard the incomplete ZIP and try again.");
      }
    },
    cancel() {
      void download.reader.cancel(new DOMException("Download cancelled", "AbortError")).catch(() => {});
      endDownload(download, "cancelled", "The browser cancelled the download.");
    },
  }, { highWaterMark: 0 });
  const encodedName = encodeURIComponent(download.filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  event.respondWith(new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="Orole Drive.zip"; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  }));
  download.port.postMessage({ type: "started" });
});
