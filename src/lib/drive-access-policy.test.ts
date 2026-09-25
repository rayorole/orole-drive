import assert from "node:assert/strict";
import test from "node:test";
import { evaluateItemAccess, evaluatePublicItemAccess } from "./drive-access-policy";
import type { DriveAccessNode } from "./drive-access-policy";
import { DriveError, LockedFolderError } from "./drive-errors";

function folder(id: string, parentId: string | null, overrides: Partial<DriveAccessNode> = {}): DriveAccessNode {
  return {
    id, name: id, parentId, kind: "folder", state: "complete", trashed: false, deleting: false,
    hasPassword: false, unlocked: false, ownerId: "owner", owner: { id: "owner", name: "Owner", email: "owner@orole.be" },
    hasActivePublicLink: false, hasSharedMembers: false,
    accessMode: parentId ? "inherit" : "private", memberRole: "viewer", selectedRole: null, ...overrides,
  };
}

function nodes(...items: DriveAccessNode[]): Map<string, DriveAccessNode> {
  return new Map(items.map((item) => [item.id, item]));
}

test("only the immutable owner can manage; viewers read and editors write", () => {
  const item = folder("item", null, { accessMode: "members" });
  const tree = nodes(item);
  assert.equal(evaluateItemAccess(tree, "item", "owner", { permission: "manage" }).permission, "owner");
  assert.equal(evaluateItemAccess(tree, "item", "member").permission, "viewer");
  assert.throws(() => evaluateItemAccess(tree, "item", "member", { permission: "write" }), DriveError);
  item.memberRole = "editor";
  assert.equal(evaluateItemAccess(tree, "item", "member", { permission: "write" }).permission, "editor");
  assert.throws(() => evaluateItemAccess(tree, "item", "member", { permission: "manage" }), DriveError);
});

test("private defaults and unknown owners never grant another account access", () => {
  const item = folder("item", null);
  const tree = nodes(item);
  assert.throws(() => evaluateItemAccess(tree, "item", "member"), DriveError);
  item.ownerId = null;
  item.owner = null;
  item.accessMode = "members";
  assert.throws(() => evaluateItemAccess(tree, "item", "owner"), DriveError);
  assert.throws(() => evaluateItemAccess(tree, "item", "member"), DriveError);
});

test("selected-account mismatch stops inheritance rather than falling back to broad ancestor grants", () => {
  const selected = folder("selected", "root", { accessMode: "selected" });
  const tree = nodes(folder("root", null, { accessMode: "members", memberRole: "editor" }), selected, folder("child", "selected"));
  assert.throws(() => evaluateItemAccess(tree, "child", "member"), DriveError);
  selected.selectedRole = "viewer";
  assert.equal(evaluateItemAccess(tree, "child", "member").permission, "viewer");
  assert.throws(() => evaluateItemAccess(tree, "child", "member", { permission: "write" }), DriveError);
});

test("Only me overrides folder grants and a folder owner's inherited editor privilege", () => {
  const child = folder("child", "root", { ownerId: "uploader", owner: { id: "uploader", name: "Uploader", email: "uploader@orole.be" } });
  const tree = nodes(folder("root", null, { accessMode: "members", memberRole: "editor" }), child);
  assert.equal(evaluateItemAccess(tree, "child", "owner").permission, "editor");
  assert.throws(() => evaluateItemAccess(tree, "child", "owner", { permission: "manage" }), DriveError);
  child.accessMode = "private";
  assert.throws(() => evaluateItemAccess(tree, "child", "owner"), DriveError);
  assert.throws(() => evaluateItemAccess(tree, "child", "member"), DriveError);
  assert.equal(evaluateItemAccess(tree, "child", "uploader", { permission: "manage" }).permission, "owner");
});

test("a directly shared nested item works without granting or disclosing its private ancestor", () => {
  const tree = nodes(folder("private-parent", null), folder("direct", "private-parent", { accessMode: "selected", selectedRole: "editor" }));
  const access = evaluateItemAccess(tree, "direct", "member", { permission: "write" });
  assert.equal(access.parentId, null);
  assert.equal(access.owner?.email, "owner@orole.be");
  assert.throws(() => evaluateItemAccess(tree, "private-parent", "member"), DriveError);
  tree.get("private-parent")!.hasPassword = true;
  assert.throws(() => evaluateItemAccess(tree, "direct", "member"), (error) => error instanceof DriveError && !(error instanceof LockedFolderError) && !error.message.includes("private-parent"));
});

test("a direct locked folder exposes its metadata, never its descendants, even to its owner", () => {
  const tree = nodes(folder("locked", null, { hasPassword: true }), folder("inside", "locked"));
  const access = evaluateItemAccess(tree, "locked", "owner", { includeSelf: false });
  assert.equal(access.hasPassword, true);
  assert.equal(access.isLocked, true);
  assert.equal(access.isProtected, true);
  assert.throws(() => evaluateItemAccess(tree, "locked", "owner"), LockedFolderError);
  assert.throws(() => evaluateItemAccess(tree, "inside", "owner", { includeSelf: false }), LockedFolderError);
});

test("nested locks disclose only the outermost accessible challenge; revocation closes descendants", () => {
  const outer = folder("outer", null, { hasPassword: true });
  const inner = folder("secret-inner-name", "outer", { hasPassword: true });
  const tree = nodes(outer, inner, folder("file", "secret-inner-name", { kind: "file" }));
  assert.throws(() => evaluateItemAccess(tree, "file", "owner"), (error) => error instanceof LockedFolderError && error.lockedFolder.id === "outer");
  outer.unlocked = true;
  assert.throws(() => evaluateItemAccess(tree, "file", "owner"), (error) => error instanceof LockedFolderError && error.lockedFolder.id === "secret-inner-name");
  inner.unlocked = true;
  assert.equal(evaluateItemAccess(tree, "file", "owner").isProtected, true);
  outer.unlocked = false;
  assert.throws(() => evaluateItemAccess(tree, "file", "owner"), LockedFolderError);
});

test("Trash access never bypasses passwords; active access rejects trashed and deleting ancestors", () => {
  for (const flags of [{ trashed: true }, { deleting: true }]) {
    const parent = folder("parent", null, flags);
    const child = folder("child", "parent", { hasPassword: true });
    const tree = nodes(parent, child);
    assert.throws(() => evaluateItemAccess(tree, "child", "owner"), DriveError);
    assert.throws(() => evaluateItemAccess(tree, "child", "owner", { allowTrashed: true }), LockedFolderError);
    child.unlocked = true;
    assert.equal(evaluateItemAccess(tree, "child", "owner", { allowTrashed: true }).permission, "owner");
  }
});

test("missing parents, file parents, pending ancestors and cycles fail closed", () => {
  for (const tree of [
    nodes(folder("child", "missing")),
    nodes(folder("parent", null, { kind: "file" }), folder("child", "parent")),
    nodes(folder("parent", null, { state: "pending" }), folder("child", "parent")),
    nodes(folder("parent", "child"), folder("child", "parent")),
  ]) assert.throws(() => evaluateItemAccess(tree, "child", "owner"), DriveError);
});

test("64 folder levels allow contained files but reject a 65th folder", () => {
  const tree = new Map<string, DriveAccessNode>();
  for (let depth = 1; depth <= 64; depth += 1) tree.set(String(depth), folder(String(depth), depth === 1 ? null : String(depth - 1)));
  tree.set("file", folder("file", "64", { kind: "file" }));
  tree.set("65", folder("65", "64"));
  assert.equal(evaluateItemAccess(tree, "file", "owner").permission, "owner");
  assert.throws(() => evaluateItemAccess(tree, "65", "owner"), DriveError);
});

test("public subtree access follows inherit only; an explicit child token is independent", () => {
  const child = folder("child", "public-root");
  const tree = nodes(folder("public-root", null), child, folder("file", "child", { kind: "file" }));
  evaluatePublicItemAccess(tree, "file", "public-root");
  for (const accessMode of ["private", "members", "selected"] as const) {
    child.accessMode = accessMode;
    assert.throws(() => evaluatePublicItemAccess(tree, "file", "public-root"), DriveError);
    evaluatePublicItemAccess(tree, "child");
  }
  assert.throws(() => evaluatePublicItemAccess(tree, "child", "unrelated-token-root"), DriveError);
  assert.throws(() => evaluateItemAccess(tree, "public-root", "member"), DriveError);
});

test("a public token cannot bypass unknown ownership, pending state, ancestor passwords or Trash", () => {
  const root = folder("root", null);
  const item = folder("item", "root", { kind: "file" });
  const tree = nodes(root, item);
  for (const flags of [{ hasPassword: true }, { trashed: true }, { deleting: true }]) {
    Object.assign(root, flags);
    assert.throws(() => evaluatePublicItemAccess(tree, "item"), DriveError);
    Object.assign(root, { hasPassword: false, trashed: false, deleting: false });
  }
  item.ownerId = null;
  assert.throws(() => evaluatePublicItemAccess(tree, "item"), DriveError);
  item.ownerId = "owner";
  item.state = "pending";
  assert.throws(() => evaluatePublicItemAccess(tree, "item"), DriveError);
});

test("sharing indicators describe audiences independently of the owner's role", () => {
  const root = folder("root", null, { accessMode: "members", hasActivePublicLink: true });
  const tree = nodes(root, folder("child", "root"));
  assert.deepEqual(evaluateItemAccess(tree, "root", "owner").sharing, { public: "direct", members: "all", membersInherited: false });
  assert.deepEqual(evaluateItemAccess(tree, "child", "owner").sharing, { public: "inherited", members: "all", membersInherited: true });
});

test("explicit child access stops public and member sharing indicators from ancestors", () => {
  const child = folder("child", "root", { accessMode: "private" });
  const tree = nodes(folder("root", null, { accessMode: "members", hasActivePublicLink: true }), child);
  assert.deepEqual(evaluateItemAccess(tree, "child", "owner").sharing, { public: null, members: null, membersInherited: false });
  child.accessMode = "selected";
  child.hasSharedMembers = true;
  assert.deepEqual(evaluateItemAccess(tree, "child", "owner").sharing, { public: null, members: "selected", membersInherited: false });
  child.hasActivePublicLink = true;
  assert.equal(evaluateItemAccess(tree, "child", "owner").sharing.public, "direct");
});

test("expired links, empty selections, protected and trashed items have no misleading public badge", () => {
  const item = folder("item", null, { accessMode: "selected" });
  const tree = nodes(item);
  assert.deepEqual(evaluateItemAccess(tree, "item", "owner").sharing, { public: null, members: null, membersInherited: false });
  item.hasActivePublicLink = true;
  item.hasPassword = true;
  item.unlocked = true;
  assert.equal(evaluateItemAccess(tree, "item", "owner").sharing.public, null);
  item.hasPassword = false;
  item.trashed = true;
  assert.equal(evaluateItemAccess(tree, "item", "owner", { allowTrashed: true }).sharing.public, null);
});

test("another uploader's inherited item is shared with its ancestor owner", () => {
  const child = folder("child", "root", { ownerId: "uploader" });
  const tree = nodes(folder("root", null), child);
  assert.deepEqual(evaluateItemAccess(tree, "child", "uploader").sharing, { public: null, members: "selected", membersInherited: true });
  child.accessMode = "private";
  assert.equal(evaluateItemAccess(tree, "child", "uploader").sharing.members, null);
});
