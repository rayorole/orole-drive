import "server-only";

import { join } from "node:path";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MCP_PDF_MAX_BYTES = 5 * 1_048_576;
const PDF_MAX_PAGES = 20;
const PDF_MAX_CHARACTERS = 64_000;
const standardFontDataUrl = join(process.cwd(), "public", "pdf-assets", "standard_fonts").replaceAll("\\", "/") + "/";

/** Bound the actual storage response as well as the drive's recorded file size. */
export async function downloadMcpBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(15_000);
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

export async function extractMcpPdf(bytes: Uint8Array) {
  // Externalized in Next so PDF.js can resolve its Node fake-worker module.
  const task = getDocument({
    data: bytes, disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true,
    standardFontDataUrl,
  });
  try {
    const document = await task.promise;
    const chunks: string[] = [];
    let characters = 0;
    let pagesRead = 0;
    let truncated = document.numPages > PDF_MAX_PAGES;
    for (let number = 1; number <= Math.min(document.numPages, PDF_MAX_PAGES); number++) {
      const page = await document.getPage(number);
      const reader = page.streamTextContent().getReader();
      chunks.push(`\n[Page ${number}]\n`);
      try {
        while (characters < PDF_MAX_CHARACTERS) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (!("str" in item)) continue;
            const text = item.str + (item.hasEOL ? "\n" : " ");
            const remaining = PDF_MAX_CHARACTERS - characters;
            chunks.push(text.slice(0, remaining));
            characters += Math.min(text.length, remaining);
            if (text.length >= remaining) { truncated = true; break; }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        page.cleanup();
      }
      pagesRead++;
      if (characters >= PDF_MAX_CHARACTERS) break;
    }
    const text = characters ? chunks.join("").trim() : "No extractable text was found. This PDF may contain scanned images; OCR is not available. Use get_download_link to view the original.";
    return { text, pagesRead, totalPages: document.numPages, truncated };
  } finally {
    await task.destroy();
  }
}
