import assert from "node:assert/strict";
import test from "node:test";
import { copyName } from "./copy-name";

test("keeps the name when the destination doesn't have it", () => {
  assert.equal(copyName("photo.jpg", "file", new Set(["other.jpg"])), "photo.jpg");
});

test("adds (copy) before a file's extension, then numbers further copies", () => {
  assert.equal(copyName("photo.jpg", "file", new Set(["photo.jpg"])), "photo (copy).jpg");
  assert.equal(copyName("photo.jpg", "file", new Set(["photo.jpg", "photo (copy).jpg"])), "photo (copy 2).jpg");
});

test("treats dots in folder names and dotfiles as part of the name", () => {
  assert.equal(copyName("v1.2", "folder", new Set(["v1.2"])), "v1.2 (copy)");
  assert.equal(copyName(".env", "file", new Set([".env"])), ".env (copy)");
});

test("stays within the 255 character limit", () => {
  const long = `${"a".repeat(251)}.txt`;
  const result = copyName(long, "file", new Set([long]));
  assert.equal(result.length, 255);
  assert.ok(result.endsWith(" (copy).txt"));
});
