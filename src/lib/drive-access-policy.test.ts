import assert from "node:assert/strict";
import test from "node:test";
import { evaluateItemAccess } from "./drive-access-policy";
import type { DriveAccessNode } from "./drive-access-policy";
import { DriveError, LockedFolderError } from "./drive-errors";

function folder(id: string, parentId: string | null, overrides: Partial<DriveAccessNode> = {}): DriveAccessNode {
  return { id, name: id, parentId, kind: "folder", state: "complete", trashed: false, deleting: false, hasPassword: false, unlocked: false, ...overrides };
}

function nodes(...items: DriveAccessNode[]): Map<string, DriveAccessNode> {
  return new Map(items.map((item) => [item.id, item]));
}

test("a direct locked folder exposes only its metadata, never its descendants", () => {
  const tree = nodes(folder("private", null, { hasPassword: true }), folder("inside", "private"));
  assert.deepEqual(evaluateItemAccess(tree, "private", { includeSelf: false }), {
    hasPassword: true, isLocked: true, isProtected: true,
  });
  assert.throws(() => evaluateItemAccess(tree, "private"), LockedFolderError);
  assert.throws(() => evaluateItemAccess(tree, "inside", { includeSelf: false }), LockedFolderError);
});

test("nested locks disclose the outermost inaccessible folder, not a hidden name", () => {
  const tree = nodes(
    folder("outer", null, { hasPassword: true }),
    folder("secret-inner-name", "outer", { hasPassword: true }),
    folder("file", "secret-inner-name", { kind: "file" }),
  );
  assert.throws(() => evaluateItemAccess(tree, "file"), (error) =>
    error instanceof LockedFolderError && error.lockedFolder.id === "outer",
  );
  tree.get("outer")!.unlocked = true;
  assert.throws(() => evaluateItemAccess(tree, "file"), (error) =>
    error instanceof LockedFolderError && error.lockedFolder.id === "secret-inner-name",
  );
});

test("an inner grant never bypasses a revoked outer grant", () => {
  const outer = folder("outer", null, { hasPassword: true, unlocked: true });
  const tree = nodes(outer, folder("inner", "outer", { hasPassword: true, unlocked: true }));
  assert.deepEqual(evaluateItemAccess(tree, "inner"), { hasPassword: true, isLocked: false, isProtected: true });
  outer.unlocked = false;
  assert.throws(() => evaluateItemAccess(tree, "inner"), LockedFolderError);
});

test("Trash permission never bypasses passwords and active access rejects trashed ancestors", () => {
  const parent = folder("parent", null, { trashed: true });
  const child = folder("child", "parent", { hasPassword: true });
  const tree = nodes(parent, child);
  assert.throws(() => evaluateItemAccess(tree, "child"), DriveError);
  assert.throws(() => evaluateItemAccess(tree, "child", { allowTrashed: true }), LockedFolderError);
  child.unlocked = true;
  assert.deepEqual(evaluateItemAccess(tree, "child", { allowTrashed: true }), {
    hasPassword: true, isLocked: false, isProtected: true,
  });
});

test("missing parents, file parents, pending ancestors and cycles fail closed", () => {
  for (const tree of [
    nodes(folder("child", "missing")),
    nodes(folder("parent", null, { kind: "file" }), folder("child", "parent")),
    nodes(folder("parent", null, { state: "pending" }), folder("child", "parent")),
    nodes(folder("parent", "child"), folder("child", "parent")),
  ]) {
    assert.throws(() => evaluateItemAccess(tree, "child"), DriveError);
  }
});

test("64 folder levels allow contained files but reject a 65th folder", () => {
  const tree = new Map<string, DriveAccessNode>();
  for (let depth = 1; depth <= 64; depth += 1) {
    tree.set(String(depth), folder(String(depth), depth === 1 ? null : String(depth - 1)));
  }
  tree.set("file", folder("file", "64", { kind: "file" }));
  tree.set("65", folder("65", "64"));
  assert.deepEqual(evaluateItemAccess(tree, "file"), { hasPassword: false, isLocked: false, isProtected: false });
  assert.throws(() => evaluateItemAccess(tree, "65"), DriveError);
});

test("deletion tombstones deny active access but remain available for Trash cleanup", () => {
  const tree = nodes(folder("deleting", null, { deleting: true }));
  assert.throws(() => evaluateItemAccess(tree, "deleting"), DriveError);
  assert.deepEqual(evaluateItemAccess(tree, "deleting", { allowTrashed: true }), {
    hasPassword: false, isLocked: false, isProtected: false,
  });
});
