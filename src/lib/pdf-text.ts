import "server-only";

import { join } from "node:path";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Shared bounded text-layer extraction; requested windows can start after page 20. No PDF OCR. */
export const PDF_TEXT_MAX_BYTES = 5 * 1_048_576;
const PDF_MAX_PAGES = 20;
const PDF_MAX_CHARACTERS = 64_000;
const standardFontDataUrl = join(process.cwd(), "public", "pdf-assets", "standard_fonts").replaceAll("\\", "/") + "/";

export type PdfText = { pages: { page: number; text: string }[]; pagesRead: number; totalPages: number; truncated: boolean; nextCursor: { page: number; offset: number } | null };
export type PdfTextRange = { startPage?: number; endPage?: number; offset?: number; maxCharacters?: number; signal?: AbortSignal };

/** Bound the actual storage response as well as the drive's recorded file size. */
export async function downloadBoundedBytes(url: string, maxBytes: number, callerSignal?: AbortSignal): Promise<Uint8Array> {
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(callerSignal ? [callerSignal] : [])]);
  const response = await fetch(url, {
    signal, cache: "no-store", credentials: "omit",
    headers: { Range: `bytes=0-${maxBytes}` },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("The file could not be downloaded for reading.");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxBytes + 1);
  let length = 0;
  try {
    while (length < bytes.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const count = Math.min(value.length, bytes.length - length);
      bytes.set(value.subarray(0, count), length);
      length += count;
    }
    if (length > maxBytes) throw new Error("This file exceeds the safe reading limit. Use get_download_link instead.");
    return bytes.subarray(0, length);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function extractPdfText(bytes: Uint8Array, range: PdfTextRange = {}): Promise<PdfText> {
  const startPage = range.startPage ?? 1;
  const endPage = range.endPage ?? startPage + PDF_MAX_PAGES - 1;
  const offset = range.offset ?? 0;
  const limit = range.maxCharacters ?? PDF_MAX_CHARACTERS;
  if (!Number.isSafeInteger(startPage) || startPage < 1 || !Number.isSafeInteger(endPage) || endPage < startPage || endPage - startPage >= PDF_MAX_PAGES ||
      !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PDF_MAX_CHARACTERS) throw new Error("Request 1–20 PDF pages and at most 64,000 characters.");
  range.signal?.throwIfAborted();
  const task = getDocument({
    data: Buffer.isBuffer(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes, disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true,
    standardFontDataUrl,
  });
  const abort = () => { void task.destroy(); };
  range.signal?.addEventListener("abort", abort, { once: true });
  try {
    const document = await task.promise;
    if (startPage > document.numPages) throw new Error(`The PDF has ${document.numPages} pages.`);
    const pages: PdfText["pages"] = [];
    let characters = 0;
    let nextCursor: PdfText["nextCursor"] = null;
    for (let number = startPage; number <= Math.min(document.numPages, endPage); number++) {
      range.signal?.throwIfAborted();
      const page = await document.getPage(number);
      const reader = page.streamTextContent().getReader();
      const chunks: string[] = [];
      let position = 0;
      const skip = number === startPage ? offset : 0;
      let clipped = false;
      let streamComplete = false;
      try {
        while (!clipped) {
          const { done, value } = await reader.read();
          if (done) { streamComplete = true; break; }
          for (const item of value.items) {
            if (!("str" in item)) continue;
            const text = item.str + (item.hasEOL ? "\n" : " ");
            const from = Math.max(0, skip - position);
            position += text.length;
            if (from >= text.length) continue;
            const remaining = limit - characters;
            const available = text.slice(from);
            chunks.push(available.slice(0, remaining));
            characters += Math.min(available.length, remaining);
            if (available.length > remaining) {
              nextCursor = { page: number, offset: position - available.length + remaining };
              clipped = true;
              break;
            }
          }
        }
        if (skip > position) throw new Error("The PDF text offset is beyond that page.");
      } finally {
        // PDF.js requires an Error reason before marking its worker stream closed. Cancelling
        // without one closes the native stream but leaves the worker able to enqueue/close it.
        if (!streamComplete && !range.signal?.aborted) await reader.cancel(new Error("The requested PDF text range is complete."));
        reader.releaseLock();
        page.cleanup();
      }
      pages.push({ page: number, text: chunks.join("") });
      if (clipped) break;
      nextCursor = number < document.numPages ? { page: number + 1, offset: 0 } : null;
      if (characters >= limit) break;
    }
    return { pages, pagesRead: pages.length, totalPages: document.numPages, truncated: nextCursor !== null, nextCursor };
  } finally {
    range.signal?.removeEventListener("abort", abort);
    await task.destroy();
  }
}

/** The MCP rendering: one text with `[Page n]` markers, or an explanation when there is no text layer. */
export function pdfPlainText(pdf: PdfText): string {
  const text = pdf.pages.map(({ page, text }) => `\n[Page ${page}]\n${text}`).join("").trim();
  return pdf.pages.some((page) => page.text) ? text : "No extractable text was found. This PDF may contain scanned images; OCR is not available. Use get_download_link to view the original.";
}
