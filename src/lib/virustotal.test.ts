import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { Readable, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

test("scan uploads reject oversized files and preserve bounded streaming under backpressure", { timeout: 10_000 }, async () => {
  const originalApiKey = process.env.VIRUSTOTAL_API_KEY;
  process.env.VIRUSTOTAL_API_KEY = "isolated-smoke-placeholder";
  let networkCalls = 0;
  let produced = 0;
  let sourceDestroyed = false;
  let sourceBytes = 4 * 1024 * 1024;
  let stalled = true;
  let release: (() => void) | undefined;
  let reachedSink!: () => void;
  const sinkBlocked = new Promise<void>((resolve) => { reachedSink = resolve; });
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(64 * 1024, 97);
  const nativeRequest = https.request;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Patched fetch must never handle scan bytes"); };
  https.request = ((url: URL, options: { method: string; signal: AbortSignal }, callback: (response: Readable) => void) => {
    networkCalls++;
    const upload = options.method === "POST";
    const req = new Writable({
      highWaterMark: 16 * 1024,
      write(data, _encoding, done) {
        chunks.push(Buffer.from(data));
        if (stalled) {
          release = () => { stalled = false; done(); };
          reachedSink();
        } else done();
      },
      final(done) {
        const response = upload
          ? Readable.from([Buffer.from(JSON.stringify({ data: { id: "isolated-analysis" } }))])
          : Readable.from((async function* () {
              for (let offset = 0; offset < sourceBytes; offset += chunk.length) {
                const piece = chunk.subarray(0, Math.min(chunk.length, sourceBytes - offset));
                produced += piece.length;
                yield piece;
              }
            })(), { objectMode: false, highWaterMark: chunk.length });
        Object.assign(response, { statusCode: 200, headers: {} });
        if (!upload) response.on("close", () => { sourceDestroyed = true; });
        queueMicrotask(() => callback(response));
        done();
      },
    });
    options.signal.addEventListener("abort", () => req.destroy(), { once: true });
    assert.equal(url.protocol, "https:");
    return req;
  }) as typeof https.request;
  syncBuiltinESMExports();
  try {
    // Load after replacing HTTPS so the test isolates the transport module boundary.
    const { submitFileForScanning, hashRemoteFile } = await import("./virustotal");
    for (const size of [1_800_000_000, 650_000_001, -1, NaN, Infinity]) {
      assert.equal(await submitFileForScanning("https://storage.invalid/file", size, "fixture.bin"), null);
    }
    assert.equal(networkCalls, 0, "Invalid/oversized submissions must not open storage or VirusTotal");
    const pending = submitFileForScanning("https://storage.invalid/file", sourceBytes, "fixture.bin");
    await sinkBlocked;
    await nextTurn();
    await nextTurn();
    assert.ok(produced <= 256 * 1024, `Stalled sink read ahead ${produced} bytes`);
    release!();
    const result = await pending;
    const expected = createHash("sha256");
    for (let offset = 0; offset < sourceBytes; offset += chunk.length) expected.update(chunk);
    assert.equal(result?.sha256, expected.digest("hex"));
    assert.equal(result?.analysisId, "isolated-analysis");
    assert.equal(result?.report.status, "pending");
    assert.ok(sourceDestroyed, "Source must be released after upload");
    const multipart = Buffer.concat(chunks);
    const bodyStart = multipart.indexOf("\r\n\r\n") + 4;
    assert.equal(multipart.subarray(bodyStart, bodyStart + sourceBytes).every((byte) => byte === 97), true);
    assert.match(multipart.subarray(bodyStart + sourceBytes).toString(), /^\r\n--.*--\r\n$/);
    assert.equal(produced, sourceBytes);
    sourceBytes = 2 * chunk.length;
    assert.equal(await submitFileForScanning("https://storage.invalid/file", chunk.length, "too-long.bin"), null);
    assert.equal(await submitFileForScanning("https://storage.invalid/file", 3 * chunk.length, "truncated.bin"), null);
    sourceBytes = 0;
    assert.equal(await hashRemoteFile("https://storage.invalid/empty", 0), createHash("sha256").digest("hex"));
  } finally {
    https.request = nativeRequest;
    globalThis.fetch = nativeFetch;
    syncBuiltinESMExports();
    if (originalApiKey === undefined) delete process.env.VIRUSTOTAL_API_KEY;
    else process.env.VIRUSTOTAL_API_KEY = originalApiKey;
  }
});
