import assert from "node:assert/strict";
import test from "node:test";
import type { DriveRow } from "./drive-schema";
import { assertMoveDepth, childFirst, planTree, restoreRows } from "./drive-tree";

function row(id: string, parentId: string | null = null, values: Partial<DriveRow> = {}): DriveRow {
  return {
    id, parentId, name: id, kind: "folder", state: "complete", size: 0,
    mimeType: null, objectKey: null, multipartUploadId: null, etag: null,
    publicToken: null, publicExpiresAt: null, sharedByEmail: null, trashedAt: null, trashRootId: null,
    passwordHash: null, passwordVersion: null, deletionStartedAt: null,
    description: "", tags: [], folderColor: null, createdBy: null, replacesId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...values,
  };
}

const trashedAt = new Date("2026-01-02T00:00:00Z");

test("overlapping selections keep one root while preserving every descendant", () => {
  const rows = [row("root"), row("folder", "root"), row("file", "folder", { kind: "file" })];
  const tree = planTree(rows, ["file", "root", "folder", "root"]);
  assert.deepEqual(tree.roots.map((item) => item.id), ["root"]);
  assert.deepEqual(childFirst(tree.rows).map((item) => item.id), ["file", "folder", "root"]);
  assert.throws(() => planTree(rows, ["root", "missing"]), /no longer available/);
});

test("moves include subtree depth and reject both self and descendant destinations", () => {
  const rows = [row("root"), row("nested", "root"), row("file", "nested", { kind: "file" })];
  const tree = planTree(rows, ["root"]);
  const path = Array.from({ length: 62 }, (_, index) => row(`destination-${index}`, index ? `destination-${index - 1}` : null));
  assert.doesNotThrow(() => assertMoveDepth(tree, path));
  assert.throws(() => assertMoveDepth(tree, [...path, row("too-deep")]), /64 levels/);
  assert.throws(() => assertMoveDepth(tree, [rows[0]]), /itself/);
  assert.throws(() => assertMoveDepth(tree, [rows[0], rows[1]]), /subfolders/);
});

test("corrupt cycles fail closed rather than normalizing into an empty selection", () => {
  const rows = [row("first", "second"), row("second", "first")];
  assert.throws(() => planTree(rows, ["first", "second"]), /unavailable/);
  assert.throws(() => childFirst(rows), /unavailable/);
});

test("restoring a parent preserves independently trashed groups and cancels pending uploads", () => {
  const rows = [
    row("parent", null, { trashedAt, trashRootId: "parent" }),
    row("same-group", "parent", { trashedAt, trashRootId: "parent" }),
    row("file", "same-group", { kind: "file", trashedAt, trashRootId: "parent" }),
    row("independent", "parent", { trashedAt, trashRootId: "independent" }),
    row("independent-file", "independent", { kind: "file", trashedAt, trashRootId: "independent" }),
    row("pending", "parent", { kind: "file", state: "pending", trashedAt, trashRootId: "parent" }),
  ];
  const tree = planTree(rows, ["parent"]);
  assert.deepEqual(restoreRows(tree, ["parent"]).map((item) => item.id).sort(), ["file", "parent", "same-group"]);
  assert.deepEqual(restoreRows(tree, ["parent", "independent"]).map((item) => item.id).sort(), ["file", "independent", "independent-file", "parent", "same-group"]);
});

test("restoring a selected inner subtree leaves its trashed siblings untouched", () => {
  const rows = [
    row("inner", "unselected-parent", { trashedAt, trashRootId: "unselected-parent" }),
    row("inner-file", "inner", { kind: "file", trashedAt, trashRootId: "unselected-parent" }),
    row("separate", "inner", { trashedAt, trashRootId: "separate" }),
  ];
  assert.deepEqual(restoreRows(planTree(rows, ["inner", "inner-file"]), ["inner", "inner-file"]).map((item) => item.id), ["inner", "inner-file"]);
});
