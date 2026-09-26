import assert from "node:assert/strict";
import test from "node:test";
import { lineDiff } from "./line-diff";

test("changed lines keep a little context and count additions and deletions", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
  const after = ["a", "b", "c", "D", "e", "f", "g", "h", "i"].join("\n");
  const diff = lineDiff(before, after, { context: 1 });
  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 1);
  assert.deepEqual(diff.lines, [
    { kind: "context", text: "c" }, { kind: "removed", text: "d" }, { kind: "added", text: "D" }, { kind: "context", text: "e" },
    { kind: "context", text: "⋯" },
    { kind: "context", text: "h" }, { kind: "added", text: "i" },
  ]);
});

test("identical texts have no lines; line endings do not count as changes", () => {
  assert.deepEqual(lineDiff("x\r\ny\n", "x\ny"), { lines: [], additions: 0, deletions: 0, truncated: false });
});

test("very large changes fall back to a plain replacement and are capped", () => {
  const before = Array.from({ length: 50 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 50 }, (_, i) => `new ${i}`).join("\n");
  const diff = lineDiff(before, after, { maxMiddle: 10, maxLines: 20 });
  assert.equal(diff.deletions, 50);
  assert.equal(diff.additions, 50);
  assert.equal(diff.lines.length, 20);
  assert.equal(diff.truncated, true);
});
