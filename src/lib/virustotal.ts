import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type VirusScanStatus = "unknown" | "pending" | "clean" | "suspicious" | "malicious";
export type VirusScanReport = {
  status: VirusScanStatus;
  statsJson: string | null;
  permalink: string | null;
};

const VT_BASE = "https://www.virustotal.com/api/v3";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const MAX_AUTO_HASH_BYTES = 100 * 1024 * 1024;
// Decimal MB is conservative for VirusTotal's documented 32MB / 650MB limits.
const DIRECT_UPLOAD_LIMIT_BYTES = 32_000_000;
export const MAX_VT_SUBMISSION_BYTES = 650_000_000;
const MAX_JSON_BYTES = 1024 * 1024;
let activeFileStreams = 0;
const MAX_FILE_STREAMS = 2;

export function virusTotalApiKey(): string | null {
  const key = process.env.VIRUSTOTAL_API_KEY;
  return key && key.trim().length > 0 ? key.trim() : null;
}

function statusFromStats(stats: Record<string, number> | undefined): VirusScanStatus {
  if (!stats) return "unknown";
  if ((stats.malicious ?? 0) > 0) return "malicious";
  if ((stats.suspicious ?? 0) > 0) return "suspicious";
  if ((stats.harmless ?? 0) > 0 || (stats.undetected ?? 0) > 0) return "clean";
  return "unknown";
}

// Native HTTPS deliberately bypasses Next fetch caching/HMR and request-body inspection.
// pipeline and async iteration preserve backpressure; no file is materialized in memory.
async function openResponse(url: string, signal: AbortSignal, headers: Record<string, string> = {}, body?: AsyncIterable<Buffer>): Promise<IncomingMessage> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("HTTPS is required.");
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  const req = request(target, { method: body ? "POST" : "GET", headers, signal }, resolve);
  req.on("error", reject);
  if (body) void pipeline(Readable.from(body, { objectMode: false }), req, { signal }).catch(reject);
  else req.end();
  return promise;
}

async function readJson(response: IncomingMessage): Promise<unknown> {
  try {
    if (response.statusCode !== 200) throw new Error("VirusTotal request failed.");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) throw new Error("VirusTotal response is too large.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } finally {
    response.destroy();
  }
}


async function* fileChunks(source: IncomingMessage, expectedBytes: number, limit: number): AsyncGenerator<Buffer> {
  if (source.statusCode !== 200) throw new Error("File source is unavailable.");
  const declared = source.headers["content-length"];
  if (declared !== undefined && Number(declared) !== expectedBytes) throw new Error("File size changed.");
  let received = 0;
  for await (const chunk of source) {
    received += chunk.length;
    if (received > expectedBytes || received > limit) throw new Error("File exceeds the scan size limit.");
    yield chunk;
  }
  if (received !== expectedBytes) throw new Error("File download was incomplete.");
}

/** null means unavailable, not a completed negative result. */
export async function getFileReportByHash(sha256: string): Promise<VirusScanReport | null> {
  const key = virusTotalApiKey();
  if (!key || !SHA256_PATTERN.test(sha256)) return null;
  try {
    const response = await openResponse(`${VT_BASE}/files/${sha256}`, AbortSignal.timeout(20_000), { "x-apikey": key });
    if (response.statusCode === 404) {
      response.destroy();
      return { status: "unknown", statsJson: null, permalink: null };
    }
    const body = await readJson(response) as { data?: { attributes?: { last_analysis_stats?: Record<string, number> } } };
    const stats = body.data?.attributes?.last_analysis_stats;
    if (!stats) return null;
    return { status: statusFromStats(stats), statsJson: JSON.stringify(stats), permalink: `https://www.virustotal.com/gui/file/${sha256}` };
  } catch {
    return null;
  }
}

export async function getAnalysisReport(analysisId: string, sha256: string): Promise<VirusScanReport | null> {
  const key = virusTotalApiKey();
  if (!key || !analysisId || !SHA256_PATTERN.test(sha256)) return null;
  try {
    const response = await openResponse(`${VT_BASE}/analyses/${encodeURIComponent(analysisId)}`, AbortSignal.timeout(20_000), { "x-apikey": key });
    if (response.statusCode === 404) {
      response.destroy();
      return getFileReportByHash(sha256);
    }
    const body = await readJson(response) as { data?: { attributes?: { status?: string; stats?: Record<string, number> } } };
    const attributes = body.data?.attributes;
    if (!attributes || !["queued", "in-progress", "completed"].includes(attributes.status ?? "")) return null;
    if (attributes.status !== "completed") return { status: "pending", statsJson: null, permalink: null };
    return { status: statusFromStats(attributes.stats), statsJson: attributes.stats ? JSON.stringify(attributes.stats) : null, permalink: `https://www.virustotal.com/gui/file/${sha256}` };
  } catch {
    return null;
  }
}

export async function hashRemoteFile(url: string, sizeBytes: number, signal?: AbortSignal): Promise<string | null> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_AUTO_HASH_BYTES || activeFileStreams >= MAX_FILE_STREAMS) return null;
  activeFileStreams++;
  let source: IncomingMessage | undefined;
  try {
    const timeout = AbortSignal.timeout(120_000);
    source = await openResponse(url, signal ? AbortSignal.any([signal, timeout]) : timeout);
    const hash = createHash("sha256");
    for await (const chunk of fileChunks(source, sizeBytes, MAX_AUTO_HASH_BYTES)) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    source?.destroy();
    activeFileStreams--;
  }
}

/** Explicit consent only. Reject oversized metadata before downloading even one byte. */
export async function submitFileForScanning(url: string, sizeBytes: number, filename: string): Promise<{ sha256: string; analysisId: string; report: VirusScanReport } | null> {
  const key = virusTotalApiKey();
  if (!key || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_VT_SUBMISSION_BYTES || activeFileStreams >= MAX_FILE_STREAMS) return null;
  activeFileStreams++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
  timeout.unref();
  let source: IncomingMessage | undefined;
  let upload: IncomingMessage | undefined;
  try {
    let uploadUrl = `${VT_BASE}/files`;
    if (sizeBytes > DIRECT_UPLOAD_LIMIT_BYTES) {
      const response = await openResponse(`${VT_BASE}/files/upload_url`, controller.signal, { "x-apikey": key });
      const payload = await readJson(response) as { data?: string };
      if (!payload.data) return null;
      const target = new URL(payload.data);
      if (target.protocol !== "https:" || target.username || target.password || (target.hostname !== "virustotal.com" && !target.hostname.endsWith(".virustotal.com"))) return null;
      uploadUrl = target.href;
    }
    source = await openResponse(url, controller.signal);
    const file = source;
    const boundary = `----oroleVt${randomBytes(16).toString("hex")}`;
    const safeName = filename.replace(/["\\\r\n]/g, "_").slice(0, 255);
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const hash = createHash("sha256");
    let complete = false;
    async function* multipart() {
      yield header;
      for await (const chunk of fileChunks(file, sizeBytes, MAX_VT_SUBMISSION_BYTES)) {
        hash.update(chunk);
        yield chunk;
      }
      yield footer;
      complete = true;
    }
    upload = await openResponse(uploadUrl, controller.signal, {
      "x-apikey": key,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(header.length + sizeBytes + footer.length),
    }, multipart());
    const result = await readJson(upload) as { data?: { id?: string } };
    if (!complete || !result.data?.id) return null;
    return { sha256: hash.digest("hex"), analysisId: result.data.id, report: { status: "pending", statsJson: null, permalink: null } };
  } catch {
    return null;
  } finally {
    controller.abort();
    clearTimeout(timeout);
    source?.destroy();
    upload?.destroy();
    activeFileStreams--;
  }
}
