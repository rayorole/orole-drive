export type SearchSection = { text: string; location: string | null };
export type SearchChunk = { ordinal: number; location: string | null; text: string };

export const CHUNK_TARGET = 1_500;
export const CHUNK_OVERLAP = 200;
/** Bounds embedding cost per file; extraction limits already keep ordinary files far below this. */
export const MAX_CHUNKS = 200;

/** Collapses runs of spaces and blank lines, keeping paragraph breaks as the strongest boundary. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function lastMatchEnd(text: string, pattern: RegExp, from: number, to: number): number {
  let end = -1;
  for (const match of text.slice(from, to).matchAll(pattern)) end = from + match.index + match[0].length;
  return end;
}

/** Best cut in (start, start + target]: paragraph, then sentence, then line, then word, never earlier than half a chunk. */
function cutPoint(text: string, start: number, target: number): number {
  const limit = start + target;
  const floor = start + Math.floor(target / 2);
  for (const pattern of [/\n\n/g, /[.!?…]["')\]]?\s/g, /\n/g, /\s/g]) {
    const end = lastMatchEnd(text, pattern, floor, limit);
    if (end > floor) return end;
  }
  return limit;
}

/** Overlapping start that begins at a word, so a chunk never opens mid-word. */
function overlapStart(text: string, cut: number, start: number, overlap: number): number {
  const from = Math.max(start + 1, cut - overlap);
  const space = text.slice(from, cut).search(/\s/);
  return space === -1 ? cut : from + space + 1;
}

function splitSection(text: string, target: number, overlap: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= target) {
      pieces.push(text.slice(start));
      break;
    }
    const cut = cutPoint(text, start, target);
    pieces.push(text.slice(start, cut));
    start = overlapStart(text, cut, start, overlap);
  }
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

/**
 * Splits extracted sections into ~1,500 character passages with ~200 characters of overlap,
 * never across sections, so each passage keeps one location. The first passage starts with the
 * file name so a name-only query still finds the file. Folder paths are left out on purpose:
 * renaming an ancestor would otherwise force re-indexing everything below it.
 */
export function chunkSections(name: string, sections: SearchSection[], options: { target?: number; overlap?: number; maxChunks?: number } = {}): SearchChunk[] {
  const target = options.target ?? CHUNK_TARGET;
  const overlap = Math.min(options.overlap ?? CHUNK_OVERLAP, Math.floor(target / 2));
  const maxChunks = options.maxChunks ?? MAX_CHUNKS;
  const chunks: SearchChunk[] = [];
  for (const section of sections) {
    for (const text of splitSection(normalizeText(section.text), target, overlap)) {
      if (chunks.length >= maxChunks) return chunks;
      chunks.push({ ordinal: chunks.length, location: section.location, text: chunks.length ? text : `${name}\n\n${text}` });
    }
  }
  return chunks;
}
