import "server-only";

import { DriveError } from "@/lib/drive-errors";

export const CHAT_TEXT_MAX_BYTES = 8 * 1_048_576;
export const CHAT_DOCUMENT_CHARACTERS = 16_000;

export function decodeDocumentText(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("Binary text");
    return text;
  } catch { throw new DriveError("This file is not readable UTF-8 or UTF-16 text."); }
}

/** One-based inclusive lines, with an intra-line offset so even a long JSON line can be resumed. */
export function readDocumentLines(text: string, options: { startLine?: number; endLine?: number; offset?: number; maxCharacters?: number } = {}) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const startLine = options.startLine ?? 1;
  const endLine = options.endLine ?? startLine + 199;
  const offset = options.offset ?? 0;
  const maxCharacters = options.maxCharacters ?? CHAT_DOCUMENT_CHARACTERS;
  if (!Number.isInteger(startLine) || startLine < 1 || startLine > lines.length || !Number.isInteger(endLine) || endLine < startLine || endLine - startLine >= 200) throw new DriveError(`Request 1–200 lines within this document (${lines.length} total lines).`);
  if (!Number.isInteger(offset) || offset < 0 || offset > lines[startLine - 1].length || !Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > CHAT_DOCUMENT_CHARACTERS) throw new DriveError("That text cursor is outside the document's reading limits.");
  const result: { line: number; offset: number; text: string }[] = [];
  let remaining = maxCharacters;
  let nextCursor: { startLine: number; offset: number } | null = null;
  for (let line = startLine; line <= Math.min(lines.length, endLine); line++) {
    const from = line === startLine ? offset : 0;
    const value = lines[line - 1].slice(from);
    const part = value.slice(0, remaining);
    result.push({ line, offset: from, text: part });
    remaining -= part.length;
    if (part.length < value.length) { nextCursor = { startLine: line, offset: from + part.length }; break; }
    nextCursor = line < lines.length ? { startLine: line + 1, offset: 0 } : null;
    if (remaining <= 0) break;
  }
  return { lines: result, totalLines: lines.length, totalCharacters: text.length, truncated: nextCursor !== null, nextCursor };
}
