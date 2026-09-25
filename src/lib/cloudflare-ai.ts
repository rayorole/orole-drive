import "server-only";

import { z } from "zod";
import { searchConfig } from "@/lib/search-config";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;
/** Texts per Workers AI call; chunks are ~1,500 characters, far below bge-m3's input window. */
const EMBED_BATCH = 50;
/** Keeps NDJSON bodies around 2 MB; the HTTP API allows far more per request. */
const UPSERT_BATCH = 200;
const DELETE_BATCH = 500;
/** Vectorize's ceiling for ID-only results (metadata or values lower it). */
export const MAX_QUERY_TOP_K = 100;
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 20_000;

/** Messages carry status codes only, never request or response bodies that could hold file text. */
export class SearchServiceError extends Error {}

const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 5_000);
  // Full jitter keeps concurrent indexers from retrying in lockstep.
  return Math.random() * 200 * 2 ** attempt;
}

const cloudflareEnvelope = z.object({ success: z.literal(true), result: z.unknown() });

async function cloudflare<T extends z.ZodType>(path: string, body: string, contentType: string, result: T, signal?: AbortSignal): Promise<z.infer<T>> {
  const config = searchConfig();
  if (!config) throw new SearchServiceError("Search is not configured.");
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/${path}`;
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST", body, cache: "no-store",
        headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": contentType },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      signal?.throwIfAborted();
      if (attempt >= MAX_ATTEMPTS) throw new SearchServiceError("Cloudflare could not be reached.");
      await delay(backoffMs(attempt, null), signal);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      if (attempt >= MAX_ATTEMPTS) throw new SearchServiceError(`Cloudflare responded with status ${response.status}.`);
      await delay(backoffMs(attempt, response.headers.get("retry-after")), signal);
      continue;
    }
    const envelope = cloudflareEnvelope.safeParse(await response.json().catch(() => null));
    const parsed = envelope.success ? result.safeParse(envelope.data.result) : null;
    if (!response.ok || !parsed?.success) throw new SearchServiceError(`Cloudflare responded with status ${response.status} and an unexpected body.`);
    return parsed.data;
  }
}

const embeddingResult = z.object({ data: z.array(z.array(z.number()).length(EMBEDDING_DIMENSIONS)) });

export async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let index = 0; index < texts.length; index += EMBED_BATCH) {
    const batch = texts.slice(index, index + EMBED_BATCH);
    const { data } = await cloudflare(`ai/run/${EMBEDDING_MODEL}`, JSON.stringify({ text: batch }), "application/json", embeddingResult, signal);
    if (data.length !== batch.length) throw new SearchServiceError("Cloudflare returned the wrong number of embeddings.");
    vectors.push(...data);
  }
  return vectors;
}

const indexName = () => encodeURIComponent(searchConfig()?.index ?? "");
const mutationResult = z.object({ mutationId: z.string().optional() });

/** Mutations apply asynchronously; Postgres stays the source of truth for what exists. */
export async function vectorUpsert(vectors: { id: string; values: number[] }[], signal?: AbortSignal): Promise<void> {
  for (let index = 0; index < vectors.length; index += UPSERT_BATCH) {
    const body = vectors.slice(index, index + UPSERT_BATCH).map((vector) => JSON.stringify(vector)).join("\n");
    await cloudflare(`vectorize/v2/indexes/${indexName()}/upsert`, body, "application/x-ndjson", mutationResult, signal);
  }
}

const queryResult = z.object({ matches: z.array(z.object({ id: z.string(), score: z.number() })) });

export async function vectorQuery(vector: number[], topK: number, signal?: AbortSignal): Promise<{ id: string; score: number }[]> {
  const body = JSON.stringify({ vector, topK: Math.max(1, Math.min(MAX_QUERY_TOP_K, Math.floor(topK))), returnMetadata: "none", returnValues: false });
  return (await cloudflare(`vectorize/v2/indexes/${indexName()}/query`, body, "application/json", queryResult, signal)).matches;
}

export async function vectorDelete(ids: string[], signal?: AbortSignal): Promise<void> {
  for (let index = 0; index < ids.length; index += DELETE_BATCH) {
    await cloudflare(`vectorize/v2/indexes/${indexName()}/delete_by_ids`, JSON.stringify({ ids: ids.slice(index, index + DELETE_BATCH) }), "application/json", mutationResult, signal);
  }
}
