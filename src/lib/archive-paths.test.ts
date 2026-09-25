import assert from "node:assert/strict";
import test from "node:test";
import type { DriveArchiveItem } from "./drive-types";
import { planArchive, safeArchiveName } from "./archive-paths";

function folder(id: string, name: string, parentId: string | null = null): DriveArchiveItem {
  return { id, name, parentId, kind: "folder", size: 0 };
}

function file(id: string, name: string, parentId: string | null = null, size = 12): DriveArchiveItem {
  return { id, name, parentId, kind: "file", size };
}

test("includes nested and empty folders without counting overlapping selections twice", () => {
  const items = [folder("root", "Family"), folder("empty", "Empty", "root"), folder("child", "Photos", "root"), file("photo", "photo.jpg", "child", 123)];
  const plan = planArchive({ rootIds: ["photo", "root", "child", "root"], items: [...items, items[3]] });
  assert.deepEqual(plan.entries.map(({ path }) => path), ["Family/", "Family/Empty/", "Family/Photos/", "Family/Photos/photo.jpg"]);
  assert.equal(plan.totalBytes, 123);
  assert.equal(plan.totalFiles, 1);
});

test("a selected descendant is rooted at its own name rather than an unselected parent", () => {
  const plan = planArchive({ rootIds: ["file"], items: [file("file", "notes.txt", "outside-manifest")] });
  assert.deepEqual(plan.entries.map(({ path }) => path), ["notes.txt"]);
});

test("duplicate folders and files have deterministic paths and retain their own children", () => {
  const items = [folder("b", "Photos"), folder("a", "Photos"), file("real", "Photos (2)"), file("child-a", "one.jpg", "a"), file("child-b", "two.jpg", "b")];
  const roots = ["a", "b", "real"];
  const plan = planArchive({ rootIds: roots, items });
  assert.deepEqual(plan.entries.map(({ item, path }) => [item.id, path]), [
    ["a", "Photos/"], ["child-a", "Photos/one.jpg"], ["b", "Photos (3)/"], ["child-b", "Photos (3)/two.jpg"], ["real", "Photos (2)"],
  ]);
  assert.deepEqual(planArchive({ rootIds: [...roots].reverse(), items: [...items].reverse() }), plan);
});

test("case and Unicode-normalization collisions do not overwrite files on extraction", () => {
  const items = [file("a", "Résumé.txt"), file("b", "Re\u0301sume\u0301.txt"), file("c", "RÉSUMÉ.TXT")];
  const { entries } = planArchive({ rootIds: items.map(({ id }) => id), items });
  assert.deepEqual(entries.map(({ path }) => path), ["RÉSUMÉ.TXT", "Résumé (2).txt", "Résumé (3).txt"]);
  assert.equal(new Set(entries.map(({ path }) => path.normalize("NFC").toLowerCase())).size, 3);
});

test("unsafe paths, device names and alternate streams remain single portable components", () => {
  const names = ["../secret.txt", "..\\secret.txt", "/absolute", "C:\\folder\\file", "..", ".", "CON.txt", "LPT1", "name:stream", " trailing. ", "a\u0000b"];
  const items = names.map((name, index) => file(String(index), name));
  const { entries } = planArchive({ rootIds: items.map(({ id }) => id), items });
  for (const { path } of entries) {
    assert.equal(path.includes("/"), false);
    assert.equal(path.includes("\\"), false);
    assert.equal(path.includes(":"), false);
    assert.notEqual(path, ".");
    assert.notEqual(path, "..");
    assert.equal(path.endsWith("."), false);
    assert.equal(path.endsWith(" "), false);
    assert.equal(path.includes("\u0000"), false);
  }
  assert.equal(safeArchiveName("CON.txt"), "_CON.txt");
  assert.equal(safeArchiveName("LPT1"), "_LPT1");
});

test("long Unicode names remain valid UTF-8 and collision suffixes fit the component limit", () => {
  const name = `${"旅行".repeat(100)}.txt`;
  const { entries } = planArchive({ rootIds: ["a", "b"], items: [file("a", name), file("b", name)] });
  for (const { path } of entries) {
    const bytes = new TextEncoder().encode(path);
    assert.ok(bytes.length <= 240);
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(bytes), path);
  }
  assert.notEqual(entries[0].path, entries[1].path);
});

test("rejects missing roots, unreachable descendants, cycles and inconsistent repeated IDs", () => {
  assert.throws(() => planArchive({ rootIds: ["missing"], items: [] }), /no longer available/);
  assert.throws(() => planArchive({ rootIds: ["a"], items: [folder("a", "A"), file("orphan", "lost.txt", "missing")] }), /contents changed/);
  assert.throws(() => planArchive({ rootIds: ["a"], items: [folder("a", "A", "b"), folder("b", "B", "a")] }), /circular/);
  assert.throws(() => planArchive({ rootIds: ["a"], items: [file("a", "one.txt"), file("a", "two.txt")] }), /contents changed/);
});

test("retains multi-GiB byte totals without 32-bit overflow", () => {
  const size = 5 * 1024 ** 3;
  const plan = planArchive({ rootIds: ["a", "b"], items: [file("a", "video-a.mp4", null, size), file("b", "video-b.mp4", null, size)] });
  assert.equal(plan.totalBytes, 10 * 1024 ** 3);
  assert.equal(plan.totalFiles, 2);
});
