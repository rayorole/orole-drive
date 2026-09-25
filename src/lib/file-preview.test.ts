import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { canThumbnail, getPreviewKind, readTextPreview, TEXT_PREVIEW_BYTES, THUMBNAIL_SOURCE_BYTES } from "./file-preview";

test("active documents are source text, including misleading media MIME types", () => {
  assert.equal(getPreviewKind({ name: "photo.svg", mimeType: "image/png", kind: "file" }), "text");
  assert.equal(getPreviewKind({ name: "photo.png", mimeType: "image/svg+xml", kind: "file" }), "text");
  assert.equal(getPreviewKind({ name: "page.html", mimeType: "application/octet-stream", kind: "file" }), "text");
  assert.equal(getPreviewKind({ name: "source.TSX", mimeType: "application/octet-stream", kind: "file" }), "text");
  assert.equal(getPreviewKind({ name: "page.html", mimeType: "text/html", kind: "folder" }), null);
  assert.equal(getPreviewKind({ name: "untrusted", mimeType: "image/x-unknown", kind: "file" }), null);
  assert.equal(getPreviewKind({ name: "constructor", mimeType: "application/octet-stream", kind: "file" }), null);
});

test("safe media types retain their native preview and thumbnails stay bounded", () => {
  assert.equal(getPreviewKind({ name: "photo.jpg", mimeType: "image/jpeg", kind: "file" }), "image");
  assert.equal(getPreviewKind({ name: "movie.mp4", mimeType: "video/mp4", kind: "file" }), "video");
  assert.equal(getPreviewKind({ name: "song.mp3", mimeType: "audio/mpeg", kind: "file" }), "audio");
  assert.equal(getPreviewKind({ name: "book.pdf", mimeType: "application/pdf", kind: "file" }), "pdf");
  const image = { name: "photo.jpg", mimeType: "image/jpeg", kind: "file" as const, size: THUMBNAIL_SOURCE_BYTES };
  assert.equal(canThumbnail(image), true);
  assert.equal(canThumbnail({ ...image, size: THUMBNAIL_SOURCE_BYTES + 1 }), false);
  assert.equal(canThumbnail({ ...image, name: "active.svg" }), false);
});

test("text preview preserves HTML as text and handles byte-order-mark UTF-16", async () => {
  const source = '<svg onload="alert(1)"><script>alert(2)</script></svg>';
  const preview = await readTextPreview(`data:text/plain;base64,${Buffer.from(source).toString("base64")}`, new AbortController().signal);
  assert.equal(preview.text, source);
  assert.equal(preview.truncated, false);
  const utf16 = Buffer.from("\ufeffFamily notes: café", "utf16le");
  const decoded = await readTextPreview(`data:application/octet-stream;base64,${utf16.toString("base64")}`, new AbortController().signal);
  assert.equal(decoded.text, "Family notes: café");
  assert.equal(decoded.encoding, "UTF-16LE");
});

test("truncation omits an incomplete final character without hiding malformed interior data", async () => {
  const prefix = "a".repeat(TEXT_PREVIEW_BYTES - 1);
  const text = Buffer.from(`${prefix}€remaining text`);
  const preview = await readTextPreview(`data:text/plain;base64,${text.toString("base64")}`, new AbortController().signal);
  assert.equal(preview.text, prefix);
  assert.equal(preview.truncated, true);
  await assert.rejects(readTextPreview("data:text/plain;base64,YQD/", new AbortController().signal), /encoding/);
  await assert.rejects(readTextPreview("data:text/plain;base64,YQBi", new AbortController().signal), /binary/);
});

test("bounded streaming cancels a response that ignores Range without waiting for its end", { timeout: 10_000 }, async (context) => {
  let connectionClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => { connectionClosed = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.write("x".repeat(TEXT_PREVIEW_BYTES + 64));
    response.on("close", connectionClosed);
  });
  context.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const preview = await readTextPreview(`http://127.0.0.1:${port}`, new AbortController().signal);
  assert.equal(preview.text, "x".repeat(TEXT_PREVIEW_BYTES));
  assert.equal(preview.truncated, true);
  await closed;
});

test("closing a text preview aborts an in-progress stream", { timeout: 10_000 }, async (context) => {
  let requestStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.write("Waiting for the remainder");
    requestStarted();
  });
  context.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const controller = new AbortController();
  const preview = readTextPreview(`http://127.0.0.1:${port}`, controller.signal);
  const rejected = assert.rejects(preview, { name: "AbortError" });
  await started;
  controller.abort();
  await rejected;
});
