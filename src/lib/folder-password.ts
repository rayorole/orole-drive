import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_COST = 131_072;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
const SALT_BYTES = 32;
const KEY_BYTES = 64;
const MAX_PASSWORD_BYTES = 1_024;
const HASH_PREFIX = `scrypt$v1$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELISM}`;
const HASH_PATTERN = /^scrypt\$v1\$131072\$8\$1\$([A-Za-z0-9_-]{43})\$([A-Za-z0-9_-]{86})$/;

export function isValidFolderPassword(password: string): boolean {
  return password.length > 0 && password.isWellFormed() && Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(password, salt, KEY_BYTES, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: 256 * 1_024 * 1_024,
  }, (error, key) => {
    if (error) reject(error);
    else resolve(key);
  });
  return promise;
}

export async function hashFolderPassword(password: string): Promise<string> {
  if (!isValidFolderPassword(password)) throw new Error("Invalid folder password input.");
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt);
  return `${HASH_PREFIX}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyFolderPassword(password: string, encodedHash: string): Promise<boolean> {
  if (!isValidFolderPassword(password)) return false;
  const match = HASH_PATTERN.exec(encodedHash);
  if (!match) return false;
  const salt = Buffer.from(match[1], "base64url");
  const expected = Buffer.from(match[2], "base64url");
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES ||
      salt.toString("base64url") !== match[1] || expected.toString("base64url") !== match[2]) return false;
  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, expected);
}
