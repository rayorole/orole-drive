/** Reciprocal rank fusion constant: dampens the difference between the top few ranks of each list. */
export const RRF_K = 60;

/** Sums 1/(k + rank) over every ranked list an id appears in (rank starts at 1); duplicates within a list count once. */
export function fuseRankings(lists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return new Map([...scores].sort((a, b) => b[1] - a[1]));
}

/** Plain search terms of a query, for highlighting and snippet placement (not for matching). */
export function queryTerms(query: string): string[] {
  const terms = query.toLowerCase().replace(/(^|\s)-\S+/g, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? [];
  return [...new Set(terms.filter((term) => term.length > 1 && term !== "or"))].slice(0, 16);
}

/** About `max` characters of `text` around the first query term, on word boundaries, with ellipses where trimmed. */
export function passageSnippet(text: string, terms: string[], max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const lower = clean.toLowerCase();
  const hits = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const hit = hits.length ? Math.min(...hits) : 0;
  let start = Math.max(0, Math.min(hit - Math.floor(max / 3), clean.length - max));
  let end = Math.min(clean.length, start + max);
  if (start > 0) start = clean.indexOf(" ", start) + 1 || start;
  if (end < clean.length) end = clean.lastIndexOf(" ", end) > start ? clean.lastIndexOf(" ", end) : end;
  return `${start > 0 ? "…" : ""}${clean.slice(start, end).trim()}${end < clean.length ? "…" : ""}`;
}
