import type { DriveChatDiffLine } from "./drive-types";

export type LineDiff = { lines: DriveChatDiffLine[]; additions: number; deletions: number; truncated: boolean };

const splitLines = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");

/**
 * A unified line diff for chat: common prefix and suffix are trimmed first, the middle is aligned with
 * a bounded LCS, and unchanged lines more than `context` away from a change collapse into "⋯".
 * Inputs beyond `maxMiddle` changed lines per side are shown as a plain replacement.
 */
export function lineDiff(before: string, after: string, { context = 2, maxLines = 200, maxMiddle = 1_200 } = {}): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle: DriveChatDiffLine[] = [];
  if (midA.length <= maxMiddle && midB.length <= maxMiddle) {
    // lcs[i][j] = length of the LCS of midA[i:] and midB[j:], in one flat typed array.
    const width = midB.length + 1;
    const lcs = new Uint16Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        lcs[i * width + j] = midA[i] === midB[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) { middle.push({ kind: "context", text: midA[i] }); i++; j++; }
      // Removals before additions on ties, the way unified diffs read.
      else if (i < midA.length && (j === midB.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) { middle.push({ kind: "removed", text: midA[i] }); i++; }
      else { middle.push({ kind: "added", text: midB[j] }); j++; }
    }
  } else {
    middle.push(...midA.map((text) => ({ kind: "removed" as const, text })), ...midB.map((text) => ({ kind: "added" as const, text })));
  }
  const all: DriveChatDiffLine[] = [...a.slice(0, start).map((text) => ({ kind: "context" as const, text })), ...middle, ...a.slice(endA).map((text) => ({ kind: "context" as const, text }))];
  const additions = all.filter((line) => line.kind === "added").length;
  const deletions = all.filter((line) => line.kind === "removed").length;
  const keep = all.map(() => false);
  all.forEach((line, index) => {
    if (line.kind === "context") return;
    for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k++) keep[k] = true;
  });
  const lines: DriveChatDiffLine[] = [];
  let skipped = false;
  all.forEach((line, index) => {
    if (keep[index]) {
      if (skipped && lines.length) lines.push({ kind: "context", text: "⋯" });
      lines.push(line);
      skipped = false;
    } else skipped = true;
  });
  return { lines: lines.slice(0, maxLines), additions, deletions, truncated: lines.length > maxLines };
}
