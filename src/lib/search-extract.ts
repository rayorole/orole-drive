import "server-only";

import sharp from "sharp";
import type { DriveRow } from "@/lib/drive-schema";
import { getPreviewKind, isOfficeKind, readTextPreview } from "@/lib/file-preview";
import type { OfficeKind } from "@/lib/file-preview";
import { OFFICE_LIMITS, OfficePreviewError } from "@/lib/office-archive";
import { extractOfficeText } from "@/lib/office-text";
import { captionImage, type ImageCaptioner } from "@/lib/openrouter";
import { extractPdfText, PDF_TEXT_MAX_BYTES } from "@/lib/pdf-text";
import type { SearchSection } from "@/lib/search-chunk";
import type { SearchSkipReason } from "@/lib/search-schema";
import { readFileBytes, signDownload } from "@/lib/storage";

export const SEARCH_IMAGE_MAX_BYTES = 10 * 1_048_576;
/** Formats sharp decodes here; each is re-encoded before it goes to the caption model. */
const CAPTION_SOURCE_TYPES: Record<string, true> = {
  "image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true, "image/avif": true,
};
/** Anthropic downsamples anything larger, so bigger images only cost upload time. */
const CAPTION_MAX_EDGE = 1_568;

export type SearchSourceKind = "text" | "pdf" | OfficeKind | "image";
export type SearchExtraction = { sections: SearchSection[] } | { skip: SearchSkipReason };

/** Which extractor a file needs, decided from metadata alone. */
export function searchSource(row: Pick<DriveRow, "name" | "kind" | "mimeType" | "size">): { kind: SearchSourceKind; maxBytes: number } | { skip: SearchSkipReason } {
  const kind = getPreviewKind(row);
  if (row.kind !== "file" || !kind) return { skip: "unsupported" };
  if (row.size <= 0) return { skip: "empty" };
  // Text is read up to the preview bound, so larger files index their beginning.
  if (kind === "text") return { kind, maxBytes: Infinity };
  if (kind === "pdf") return row.size > PDF_TEXT_MAX_BYTES ? { skip: "too_large" } : { kind, maxBytes: PDF_TEXT_MAX_BYTES };
  if (isOfficeKind(kind)) return row.size > OFFICE_LIMITS.download ? { skip: "too_large" } : { kind, maxBytes: OFFICE_LIMITS.download };
  if (kind === "image") {
    if (!CAPTION_SOURCE_TYPES[row.mimeType ?? ""]) return { skip: "unsupported" };
    return row.size > SEARCH_IMAGE_MAX_BYTES ? { skip: "too_large" } : { kind, maxBytes: SEARCH_IMAGE_MAX_BYTES };
  }
  return { skip: "unsupported" };
}

const withText = (sections: SearchSection[]): SearchExtraction => {
  const kept = sections.filter((section) => section.text.trim());
  return kept.length ? { sections: kept } : { skip: "empty" };
};

/** Extraction from already downloaded bytes. Malformed, encrypted or unsafe documents are skipped rather than retried. */
export async function extractBytes(kind: Exclude<SearchSourceKind, "text">, bytes: Uint8Array, signal: AbortSignal, captioner: ImageCaptioner = captionImage): Promise<SearchExtraction> {
  if (kind === "image") {
    let data: Buffer;
    try {
      // Re-encoding strips metadata (GPS, camera serials) and bounds what the model receives.
      data = await sharp(bytes, { limitInputPixels: 100_000_000, animated: false }).rotate()
        .resize(CAPTION_MAX_EDGE, CAPTION_MAX_EDGE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    } catch {
      return { skip: "unsupported" };
    }
    return withText([{ text: await captioner({ data, mediaType: "image/jpeg" }, signal), location: "caption" }]);
  }
  try {
    if (kind === "pdf") return withText((await extractPdfText(bytes)).pages.map(({ page, text }) => ({ text: text.trim(), location: `page ${page}` })));
    return withText(await extractOfficeText(bytes, kind, signal));
  } catch (error) {
    if (signal.aborted) throw error;
    // The bytes are already in memory, so a parse failure would fail the same way on every retry.
    if (kind === "pdf" || error instanceof OfficePreviewError) return { skip: "unsupported" };
    throw error;
  }
}

/** Current contents of a complete file as searchable sections. Callers decide eligibility first. */
export async function extractForSearch(row: DriveRow, signal: AbortSignal): Promise<SearchExtraction> {
  const source = searchSource(row);
  if ("skip" in source) return source;
  if (source.kind === "text") {
    const url = await signDownload(row, true);
    if (!url) return { skip: "unsupported" };
    try {
      const { text } = await readTextPreview(url, signal);
      return withText([{ text, location: null }]);
    } catch (error) {
      // Binary data or an unsupported encoding behind a text name: nothing to index. Network errors retry.
      if (!signal.aborted && error instanceof Error && /encoding|binary data/.test(error.message)) return { skip: "unsupported" };
      throw error;
    }
  }
  const bytes = await readFileBytes(row, source.maxBytes);
  if (!bytes) throw new Error("The file could not be read for indexing.");
  return extractBytes(source.kind, bytes, signal);
}
