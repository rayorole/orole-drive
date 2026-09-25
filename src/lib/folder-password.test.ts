import assert from "node:assert/strict";
import test from "node:test";
import { hashFolderPassword, isValidFolderPassword, verifyFolderPassword } from "./folder-password";

test("password hashes use independent salts and require the exact password", async () => {
  const password = "  Family archive café \u{1f512}  ";
  const first = await hashFolderPassword(password);
  const second = await hashFolderPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyFolderPassword(password, first), true);
  assert.equal(await verifyFolderPassword(password.trim(), first), false);
  assert.equal(await verifyFolderPassword(password.normalize("NFD"), first), false);
});

test("password bounds count UTF-8 bytes and reject malformed Unicode", async () => {
  assert.equal(isValidFolderPassword("é".repeat(512)), true);
  assert.equal(isValidFolderPassword("é".repeat(513)), false);
  assert.equal(isValidFolderPassword("\ud800"), false);
  assert.equal(isValidFolderPassword(""), false);
  await assert.rejects(hashFolderPassword("é".repeat(513)));
});

test("malformed hashes and untrusted cost parameters fail closed", async () => {
  const salt = Buffer.alloc(32, 7).toString("base64url");
  const key = Buffer.alloc(64, 9).toString("base64url");
  for (const encoded of [
    "",
    `scrypt$v1$1073741824$8$1$${salt}$${key}`,
    `scrypt$v1$131072$8$1$${salt.slice(1)}$${key}`,
    `scrypt$v1$131072$8$1$${salt}$${key.slice(1)}`,
    `scrypt$v2$131072$8$1$${salt}$${key}`,
  ]) {
    assert.equal(await verifyFolderPassword("family password", encoded), false);
  }
});
