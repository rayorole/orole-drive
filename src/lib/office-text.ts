import "server-only";

import mammoth from "mammoth";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { OfficeKind } from "@/lib/file-preview";
import { OFFICE_LIMITS, OfficePreviewError, officeRelationshipTarget, readOfficeArchive } from "@/lib/office-archive";
import type { SearchSection } from "@/lib/search-chunk";

// Server-side plain text only. The browser renderer (office-document.ts) needs DOMParser; here a small
// scanner reads just the elements search needs from parts readOfficeArchive already bounded.

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (match, decimal: string, hex: string, name: string) => {
    if (name) return entities[name.toLowerCase()];
    const code = decimal ? Number(decimal) : parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** Same data-only rule as the preview: no DTDs, entities or processing instructions. */
export function xmlText(parts: Map<string, Uint8Array>, path: string): string {
  const bytes = parts.get(path);
  if (!bytes) throw new OfficePreviewError("A required document part is missing.");
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(text)) throw new OfficePreviewError("This document contains unsupported XML declarations.");
  return text;
}

/** Elements by local name, ignoring namespace prefixes. Office never nests these elements in themselves. */
export function elements(xml: string, name: string): { attributes: string; body: string }[] {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${name}(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>)`, "g");
  return Array.from(xml.matchAll(pattern), (match) => ({ attributes: match[1], body: match[2] ?? "" }));
}

export function attribute(attributes: string, name: string, prefixed = false): string | null {
  const pattern = new RegExp(`\\s${prefixed ? "[\\w.-]+:" : ""}${name}=(?:"([^"]*)"|'([^']*)')`);
  const match = pattern.exec(attributes);
  return match ? match[1] ?? match[2] : null;
}

export const textRuns = (xml: string) => elements(xml, "t").map((run) => decodeXml(run.body)).join("");

export function relationships(parts: Map<string, Uint8Array>, source: string): Map<string, { target: string; type: string }> {
  const slash = source.lastIndexOf("/");
  const path = `${source.slice(0, slash + 1)}_rels/${source.slice(slash + 1)}.rels`;
  const links = new Map<string, { target: string; type: string }>();
  if (!parts.has(path)) return links;
  for (const rel of elements(xmlText(parts, path), "Relationship")) {
    const target = officeRelationshipTarget(source, decodeXml(attribute(rel.attributes, "Target") ?? ""), attribute(rel.attributes, "TargetMode"));
    if (target && parts.has(target)) links.set(attribute(rel.attributes, "Id") ?? "", { target, type: attribute(rel.attributes, "Type") ?? "" });
  }
  return links;
}

async function wordText(parts: Map<string, Uint8Array<ArrayBuffer>>, signal: AbortSignal): Promise<SearchSection[]> {
  // Mammoth only ever sees validated XML parts, repacked uncompressed: no media, macros or external links.
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
  for (const [path, bytes] of parts) {
    if (!/\.(?:xml|rels)$/i.test(path)) continue;
    xmlText(parts, path);
    await writer.add(path, new Uint8ArrayReader(bytes), { signal });
  }
  const safeZip = await writer.close();
  signal.throwIfAborted();
  const result = await mammoth.extractRawText({ buffer: Buffer.from(safeZip) });
  return [{ text: result.value, location: null }];
}

function spreadsheetText(parts: Map<string, Uint8Array>): SearchSection[] {
  const workbook = xmlText(parts, "xl/workbook.xml");
  const links = relationships(parts, "xl/workbook.xml");
  const stringsPath = Array.from(links.values()).find((link) => link.type.endsWith("/sharedStrings"))?.target;
  // Phonetic guides (<rPh>) repeat text in another script; they are not part of the cell value.
  const strings = stringsPath ? elements(xmlText(parts, stringsPath), "si").map((item) => textRuns(item.body.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, ""))) : [];
  const sheets = elements(workbook, "sheet").filter((sheet) => !["hidden", "veryHidden"].includes(attribute(sheet.attributes, "state") ?? ""));
  if (sheets.length > OFFICE_LIMITS.sheets) throw new OfficePreviewError("This workbook has too many worksheets.");
  return sheets.flatMap((sheet) => {
    const path = links.get(attribute(sheet.attributes, "id", true) ?? "")?.target;
    if (!path) return [];
    const rows: string[][] = [];
    for (const cell of elements(xmlText(parts, path), "c")) {
      const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(attribute(cell.attributes, "r") ?? "");
      if (!match) continue;
      let column = 0;
      for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
      const row = Number(match[2]);
      // The same bounds as the preview: search covers what a member could see there.
      if (row > OFFICE_LIMITS.rows || column > OFFICE_LIMITS.columns) continue;
      const type = attribute(cell.attributes, "t");
      const value = decodeXml(elements(cell.body, "v")[0]?.body ?? "");
      // Formulas are never evaluated; only the last saved cached value is indexed.
      const text = type === "inlineStr" ? textRuns(cell.body) : type === "s" ? strings[Number(value)] ?? "" : type === "b" ? (value === "1" ? "TRUE" : "FALSE") : value;
      if (text.trim()) (rows[row - 1] ??= [])[column - 1] = text.trim();
    }
    const text = rows.filter(Boolean).map((cells) => cells.filter(Boolean).join(" | ")).join("\n");
    return [{ text, location: decodeXml(attribute(sheet.attributes, "name") ?? "Sheet") }];
  });
}

function presentationText(parts: Map<string, Uint8Array>): SearchSection[] {
  const main = xmlText(parts, "ppt/presentation.xml");
  const links = relationships(parts, "ppt/presentation.xml");
  const slides = elements(main, "sldId");
  if (slides.length > OFFICE_LIMITS.slides) throw new OfficePreviewError("This presentation has too many slides.");
  return slides.flatMap((slide, index) => {
    const path = links.get(attribute(slide.attributes, "id", true) ?? "")?.target;
    if (!path) return [];
    const text = elements(xmlText(parts, path), "p").map((paragraph) => textRuns(paragraph.body)).filter((line) => line.trim()).join("\n");
    return [{ text, location: `slide ${index + 1}` }];
  });
}

/** Shared server-side safety gate; no macros, active content or XML entity expansion. */
export async function readSafeOfficeParts(bytes: Uint8Array, signal: AbortSignal) {
  const parts = await readOfficeArchive(bytes, signal);
  for (const [path] of parts) {
    if (/vbaProject|activeX|macrosheets/i.test(path)) throw new OfficePreviewError("Macro-enabled Office files are not supported.");
    if (/\.(?:xml|rels)$/i.test(path)) xmlText(parts, path);
  }
  if (elements(xmlText(parts, "[Content_Types].xml"), "Override").some((type) => /macroEnabled/i.test(attribute(type.attributes, "ContentType") ?? ""))) {
    throw new OfficePreviewError("Macro-enabled Office files are not supported.");
  }
  signal.throwIfAborted();
  return parts;
}

/** Plain text sections of a docx/xlsx/pptx: one per worksheet or slide. */
export async function extractOfficeText(bytes: Uint8Array, kind: OfficeKind, signal: AbortSignal): Promise<SearchSection[]> {
  const parts = await readSafeOfficeParts(bytes, signal);
  return kind === "docx" ? wordText(parts, signal) : kind === "xlsx" ? spreadsheetText(parts) : presentationText(parts);
}
