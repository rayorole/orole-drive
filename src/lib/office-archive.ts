import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";

export const OFFICE_LIMITS = {
  download: 20 * 1024 * 1024,
  expanded: 40 * 1024 * 1024,
  entry: 8 * 1024 * 1024,
  xml: 2 * 1024 * 1024,
  entries: 1500,
  sheets: 40,
  rows: 200,
  columns: 50,
  slides: 100,
} as const;

export class OfficePreviewError extends Error {}
const invalid = () => new OfficePreviewError("This file is corrupt, encrypted, or not a supported Office document. Download it to open it in Office.");
const limit = () => new OfficePreviewError("This document exceeds the safe preview limits (20 MB file, 40 MB expanded, 8 MB per part, 2 MB per XML part, 1,500 parts). Download it to open it on your device.");

export async function fetchOfficeBytes(url: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { signal, cache: "no-store", credentials: "omit", headers: { Range: `bytes=0-${OFFICE_LIMITS.download}` } });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new OfficePreviewError("The document could not load. Reload the preview for a fresh link, or download the file.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (Number(response.headers.get("content-length")) > OFFICE_LIMITS.download) throw limit();
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > OFFICE_LIMITS.download) throw limit();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Never trusts declared ZIP sizes: the output sink also enforces the actual byte budget. */
export async function readOfficeArchive(bytes: Uint8Array, signal: AbortSignal): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  signal.throwIfAborted();
  if (bytes.length > OFFICE_LIMITS.download) throw limit();
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw invalid();
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  const parts = new Map<string, Uint8Array<ArrayBuffer>>();
  let count = 0;
  let expanded = 0;
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      signal.throwIfAborted();
      if (++count > OFFICE_LIMITS.entries) throw limit();
      const name = entry.filename;
      if (!name || name.length > 256 || /[\\\x00-\x1f:%?#]/.test(name) || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === ".") || parts.has(name)) throw invalid();
      if (entry.encrypted) throw invalid();
      if (entry.directory) continue;
      const cap = /\.(?:xml|rels)$/i.test(name) ? OFFICE_LIMITS.xml : OFFICE_LIMITS.entry;
      if (entry.uncompressedSize > cap || expanded + entry.uncompressedSize > OFFICE_LIMITS.expanded) throw limit();
      const chunks: Uint8Array[] = [];
      let length = 0;
      await entry.getData(new WritableStream<Uint8Array>({
        write(chunk) {
          signal.throwIfAborted();
          length += chunk.length;
          expanded += chunk.length;
          if (length > cap || expanded > OFFICE_LIMITS.expanded) throw limit();
          chunks.push(chunk);
        },
      }), { signal, checkSignature: true, checkOverlappingEntry: true, useWebWorkers: false });
      if (length !== entry.uncompressedSize) throw invalid();
      const data = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      parts.set(name, data);
    }
    if (!parts.has("[Content_Types].xml") || !parts.has("_rels/.rels")) throw invalid();
    return parts;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof OfficePreviewError) throw error;
    throw invalid();
  } finally { await reader.close(); }
}

/** OPC package-relative paths only. No URL schemes, UNC paths, query strings or encoded traversal. */
export function officeRelationshipTarget(source: string, target: string, mode: string | null): string | null {
  if (mode?.toLowerCase() === "external" || !target || /[\\\x00-\x20:%?#]/.test(target) || target.startsWith("//")) return null;
  const stack = target.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!stack.length) return null; stack.pop(); }
    else stack.push(part);
  }
  return stack.join("/");
}

/** Raster signatures and dimensions are checked before the browser decodes embedded images. */
export function officeRaster(bytes: Uint8Array): { type: string; pixels: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let type = "";
  let width = 0;
  let height = 0;
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) {
    type = "image/png"; width = view.getUint32(16); height = view.getUint32(20);
  } else if (bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/)) {
    type = "image/gif"; width = view.getUint16(6, true); height = view.getUint16(8, true);
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { type = "image/jpeg"; height = view.getUint16(offset + 5); width = view.getUint16(offset + 7); break; }
      offset += length + 2;
    }
  }
  return type && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000 ? { type, pixels: width * height } : null;
}
