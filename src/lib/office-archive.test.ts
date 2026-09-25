import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { fetchOfficeBytes, OFFICE_LIMITS, officeRaster, officeRelationshipTarget, readOfficeArchive } from "./office-archive";

async function archive(files: Record<string, Uint8Array>, password?: string) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add("[Content_Types].xml", new Uint8ArrayReader(new TextEncoder().encode("<Types/>")));
  await writer.add("_rels/.rels", new Uint8ArrayReader(new TextEncoder().encode("<Relationships/>")));
  for (const [name, data] of Object.entries(files)) await writer.add(name, new Uint8ArrayReader(data), { password });
  return writer.close();
}

test("Office ZIP rejects encrypted, corrupt and traversal packages", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(readOfficeArchive(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), signal), /corrupt, encrypted/);
  const data = new TextEncoder().encode("document");
  await assert.rejects(readOfficeArchive(await archive({ "word/document.xml": data }, "password"), signal), /corrupt, encrypted/);
  await assert.rejects(readOfficeArchive(await archive({ "../document.xml": data }), signal), /corrupt, encrypted/);
  const valid = await archive({ "word/document.xml": data });
  await assert.rejects(readOfficeArchive(valid.subarray(0, valid.length - 16), signal), /corrupt, encrypted/);
});

test("Office ZIP limits metadata and actual inflated output even when sizes lie", async () => {
  const bytes = await archive({ "word/document.xml": new Uint8Array(OFFICE_LIMITS.xml + 1).fill(32) });
  const signal = new AbortController().signal;
  await assert.rejects(readOfficeArchive(bytes, signal), /safe preview limits/);
  // Change central and local declared uncompressed sizes; the sink must still stop real output.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 46 < bytes.length; offset++) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50 && view.getUint32(offset + 24, true) > OFFICE_LIMITS.xml) view.setUint32(offset + 24, 1, true);
    if (signature === 0x04034b50 && view.getUint32(offset + 22, true) > OFFICE_LIMITS.xml) view.setUint32(offset + 22, 1, true);
  }
  await assert.rejects(readOfficeArchive(bytes, signal), /safe preview limits|corrupt, encrypted/);
});

test("Office ZIP caps cumulative expansion and entry count", async () => {
  const files: Record<string, Uint8Array> = {};
  for (let index = 0; index < 6; index++) files[`media/${index}.bin`] = new Uint8Array(OFFICE_LIMITS.entry).fill(index);
  await assert.rejects(readOfficeArchive(await archive(files), new AbortController().signal), /safe preview limits/);
  const entries: Record<string, Uint8Array> = {};
  for (let index = 0; index < OFFICE_LIMITS.entries; index++) entries[`parts/${index}`] = new Uint8Array();
  await assert.rejects(readOfficeArchive(await archive(entries), new AbortController().signal), /safe preview limits/);
});

test("Office relationships cannot escape to network, filesystem or package root", () => {
  assert.equal(officeRelationshipTarget("ppt/slides/slide1.xml", "../media/image1.png", null), "ppt/media/image1.png");
  for (const target of ["https://evil.test/a", "//evil.test/a", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "../../../../secret", "%2e%2e/secret", "..\\secret", "image.png?x", "image.png#x"]) {
    assert.equal(officeRelationshipTarget("word/document.xml", target, null), null, target);
  }
  assert.equal(officeRelationshipTarget("word/document.xml", "media/local.png", "External"), null);
});

test("Office images reject SVG/HTML and huge raster dimensions before decoding", () => {
  assert.equal(officeRaster(new TextEncoder().encode('<svg onload="alert(1)"/>')), null);
  const png = new Uint8Array(24);
  const view = new DataView(png.buffer);
  view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a); view.setUint32(12, 0x49484452);
  view.setUint32(16, 100); view.setUint32(20, 100);
  assert.deepEqual(officeRaster(png), { type: "image/png", pixels: 10000 });
  view.setUint32(16, 100000);
  assert.equal(officeRaster(png), null);
});

test("Office download cancels oversized streams and respects abort", { timeout: 10_000 }, async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.write(Buffer.alloc(OFFICE_LIMITS.download + 1));
  });
  context.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await assert.rejects(fetchOfficeBytes(`http://127.0.0.1:${port}`, new AbortController().signal), /safe preview limits/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readOfficeArchive(new Uint8Array(), controller.signal), { name: "AbortError" });
  await assert.rejects(fetchOfficeBytes(`http://127.0.0.1:${port}`, controller.signal), { name: "AbortError" });
});
