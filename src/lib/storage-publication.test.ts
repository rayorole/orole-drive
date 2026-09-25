import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { DriveError } from "./drive-errors";
import { commitUpload, createObjectKey } from "./storage";
import type { UploadObject } from "./storage";

// No database or network: model the exact immutable-object boundary shared by
// old and new deployments, including a valid PUT replay after legacy completion.
test("single-PUT finalization cannot overwrite a legacy deployment's published bytes", async (t) => {
  const envKeys = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.R2_ENDPOINT = "https://publication-tests.r2.cloudflarestorage.com";
  process.env.R2_BUCKET = "isolated-publication-tests";
  process.env.R2_ACCESS_KEY_ID = "test";
  process.env.R2_SECRET_ACCESS_KEY = "test";
  const id = randomUUID();
  const originalKey = createObjectKey(id);
  const publicationKey = createObjectKey(id);
  const stagedKey = `uploads/${originalKey.slice("files/".length)}`;
  const row: UploadObject = { id, kind: "file", objectKey: originalKey, replacesId: null, multipartUploadId: null,
    mimeType: "text/plain", size: 4, state: "pending", trashedAt: null };
  type Stored = { body: string; etag: string; uploadId: string };
  const objects = new Map<string, Stored>([
    [originalKey, { body: "OLD!", etag: "legacy-etag", uploadId: id }],
    [stagedKey, { body: "NEW!", etag: "replayed-etag", uploadId: id }],
  ]);
  t.mock.method(S3Client.prototype, "send", async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const key = String(command.input.Key);
    if (command.constructor.name === "HeadObjectCommand") {
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error("Missing"), { name: "NotFound" });
      return { ContentLength: object.body.length, ContentType: "text/plain", Metadata: { "upload-id": object.uploadId }, ETag: object.etag };
    }
    if (command.constructor.name === "CopyObjectCommand") {
      const sourceKey = String(command.input.CopySource).split("/").slice(1).join("/");
      const source = objects.get(sourceKey)!;
      assert.equal(command.input.CopySourceIfMatch, source.etag);
      objects.set(key, { ...source });
      return {};
    }
    if (command.constructor.name === "ListPartsCommand") {
      // A legacy multipart completion already consumed this upload ID.
      throw Object.assign(new Error("Already completed"), { name: "NoSuchUpload" });
    }
    throw new Error(`Unexpected storage command: ${command.constructor.name}`);
  });
  try {
    assert.equal(await commitUpload(row, publicationKey), "replayed-etag");
    assert.equal(objects.get(originalKey)?.body, "OLD!");
    assert.equal(objects.get(originalKey)?.etag, "legacy-etag");
    assert.equal(objects.get(publicationKey)?.body, "NEW!");
    // A caller cannot accidentally opt back into the unsafe legacy destination.
    await assert.rejects(commitUpload(row, originalKey), DriveError);
    assert.equal(objects.get(originalKey)?.body, "OLD!");
    // Multipart completion is different: consuming UploadId prevents another
    // final write, and exact final-object verification recovers its lost response.
    assert.equal(await commitUpload({ ...row, multipartUploadId: "consumed-upload-id" }, originalKey), "legacy-etag");
    objects.set(originalKey, { body: "OLD!", etag: "legacy-etag", uploadId: randomUUID() });
    await assert.rejects(commitUpload({ ...row, multipartUploadId: "consumed-upload-id" }, originalKey), DriveError);
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
