import assert from "node:assert/strict";
import test from "node:test";
import { NameConflictError } from "./drive-errors";
import type { DestinationSibling } from "./name-conflicts";
import { planTransfer, type TransferRoot } from "./transfer-plan";

const destination = "dest";
const siblings = (...items: DestinationSibling[]) => new Map(items.map((item) => [item.name.toLowerCase(), item]));
const file = (id: string, name: string, parentId: string | null = "elsewhere"): TransferRoot => ({ id, name, kind: "file", parentId });
const names = (plan: { items: { root: TransferRoot; name: string }[] }) => plan.items.map(({ root, name }) => [root.id, name]);

test("asks about collisions with destination items, case-insensitively", () => {
  assert.throws(
    () => planTransfer([file("a", "Photo.JPG")], siblings({ id: "x", name: "photo.jpg", kind: "file" }), {}, "move", destination),
    (error: unknown) => error instanceof NameConflictError && error.conflicts[0].existingId === "x",
  );
});

test("numbers later incoming items that share a name, without asking", () => {
  const plan = planTransfer([file("a", "notes.txt", "one"), file("b", "Notes.txt", "two")], siblings(), {}, "copy", destination);
  assert.deepEqual(names(plan), [["a", "notes.txt"], ["b", "Notes (1).txt"]]);
});

test("items keeping their own name claim it before keep-both hands out numbers", () => {
  const plan = planTransfer(
    [file("a", "photo.jpg"), file("b", "photo (1).jpg")],
    siblings({ id: "x", name: "photo.jpg", kind: "file" }), { a: "keep-both" }, "move", destination,
  );
  assert.deepEqual(names(plan), [["a", "photo (2).jpg"], ["b", "photo (1).jpg"]]);
});

test("replace frees the existing name; skip leaves the item out", () => {
  const existing = siblings({ id: "x", name: "a.txt", kind: "file" }, { id: "y", name: "b.txt", kind: "file" });
  const plan = planTransfer([file("a", "a.txt"), file("b", "b.txt")], existing, { a: "replace", b: "skip" }, "move", destination);
  assert.deepEqual(names(plan), [["a", "a.txt"]]);
  assert.deepEqual(plan.replaceIds, ["x"]);
});

test("moving into the current folder is a no-op; copying there duplicates as (copy) without asking", () => {
  const here = file("a", "a.txt", destination);
  const existing = siblings({ id: "a", name: "a.txt", kind: "file" });
  assert.deepEqual(names(planTransfer([here], existing, {}, "move", destination)), []);
  assert.deepEqual(names(planTransfer([here], existing, {}, "copy", destination)), [["a", "a (copy).txt"]]);
});
