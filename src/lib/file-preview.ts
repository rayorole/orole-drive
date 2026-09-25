import type { DriveItem } from "@/lib/drive-types";

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text";

const mediaTypes: Record<string, PreviewKind> = {
  "image/jpeg": "image", "image/png": "image", "image/gif": "image", "image/webp": "image", "image/avif": "image", "image/bmp": "image",
  "video/mp4": "video", "video/webm": "video", "video/ogg": "video", "video/quicktime": "video",
  "audio/mpeg": "audio", "audio/mp4": "audio", "audio/ogg": "audio", "audio/wav": "audio", "audio/webm": "audio", "audio/flac": "audio", "audio/aac": "audio",
  "application/pdf": "pdf",
};
const textTypes: Record<string, true> = {
  "application/json": true, "application/ld+json": true, "application/xml": true, "application/xhtml+xml": true,
  "application/javascript": true, "application/ecmascript": true, "application/typescript": true, "application/x-javascript": true,
  "application/yaml": true, "application/x-yaml": true, "application/toml": true, "application/sql": true, "application/graphql": true,
  "application/x-sh": true, "application/x-httpd-php": true, "image/svg+xml": true,
};
const textExtensions: Record<string, true> = {
  txt: true, text: true, md: true, mdx: true, markdown: true, rst: true, log: true, csv: true, tsv: true, json: true, jsonc: true, jsonl: true, ndjson: true,
  xml: true, svg: true, html: true, htm: true, xhtml: true, css: true, scss: true, sass: true, less: true, js: true, jsx: true, mjs: true, cjs: true, ts: true, tsx: true,
  yaml: true, yml: true, toml: true, ini: true, conf: true, config: true, env: true, properties: true, sql: true, graphql: true, gql: true,
  py: true, pyw: true, rb: true, php: true, go: true, rs: true, java: true, kt: true, kts: true, c: true, h: true, cc: true, cpp: true, cxx: true, hpp: true,
  cs: true, swift: true, m: true, mm: true, sh: true, bash: true, zsh: true, fish: true, ps1: true, bat: true, cmd: true, r: true, lua: true, pl: true, pm: true,
  vue: true, svelte: true, astro: true, ex: true, exs: true, erl: true, hrl: true, clj: true, cljs: true, edn: true, scala: true, dart: true, gradle: true,
  dockerfile: true, makefile: true, gitignore: true, gitattributes: true, editorconfig: true, ipynb: true, tex: true, bib: true, diff: true, patch: true,
};
const textNames: Record<string, true> = { dockerfile: true, makefile: true, gemfile: true, rakefile: true, procfile: true, license: true, readme: true };

export function getPreviewKind(item: Pick<DriveItem, "name" | "mimeType" | "kind">): PreviewKind | null {
  if (item.kind !== "file") return null;
  const mime = (item.mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
  const name = item.name.toLowerCase();
  // Active document formats are source text, even when given a misleading media MIME type.
  if (/\.(?:svg|html?|xhtml)$/.test(name) || mime.startsWith("text/") || textTypes[mime] === true || /^application\/[\w.+-]+\+(?:json|xml)$/.test(mime)) return "text";
  if (Object.hasOwn(mediaTypes, mime)) return mediaTypes[mime];
  const extension = name.slice(name.lastIndexOf(".") + 1);
  return textExtensions[extension] === true || textNames[name] === true ? "text" : null;
}

export const TEXT_PREVIEW_BYTES = 512 * 1024;
export const THUMBNAIL_SOURCE_BYTES = 12 * 1024 * 1024;
const thumbnailTypes: Record<string, true> = { "image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true, "image/avif": true };

export function canThumbnail(item: Pick<DriveItem, "name" | "mimeType" | "kind" | "size">): boolean {
  return getPreviewKind(item) === "image" && thumbnailTypes[item.mimeType ?? ""] === true && item.size > 0 && item.size <= THUMBNAIL_SOURCE_BYTES;
}

export type TextPreviewContent = { text: string; truncated: boolean; encoding: string };

export async function readTextPreview(url: string, signal: AbortSignal): Promise<TextPreviewContent> {
  // A range request bounds transfer at storage; streaming and cancellation also bound servers that ignore Range.
  const response = await fetch(url, { signal, cache: "no-store", credentials: "omit", headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES}` } });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("The text preview could not load. Reload the preview or download the file.");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(TEXT_PREVIEW_BYTES + 1);
  let length = 0;
  try {
    while (length < bytes.length) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      const count = Math.min(value.length, bytes.length - length);
      bytes.set(value.subarray(0, count), length);
      length += count;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const truncated = length > TEXT_PREVIEW_BYTES;
  const content = bytes.subarray(0, Math.min(length, TEXT_PREVIEW_BYTES));
  const utf16le = content[0] === 0xff && content[1] === 0xfe;
  const utf16be = content[0] === 0xfe && content[1] === 0xff;
  const encoding = utf16le ? "utf-16le" : utf16be ? "utf-16be" : "utf-8";
  let text: string;
  try {
    // Streaming mode tolerates only the partial final character caused by truncation, not malformed interior bytes.
    text = new TextDecoder(encoding, { fatal: true }).decode(content, { stream: truncated });
  } catch {
    throw new Error("This file uses an unsupported text encoding. Preview supports UTF-8 and UTF-16 with a byte-order mark. Download it to open it on your device.");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error("This file contains binary data and cannot be displayed as text. Download it to open it on your device.");
  }
  return { text, truncated, encoding: encoding.toUpperCase() };
}
