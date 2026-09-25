import assert from "node:assert/strict";
import test from "node:test";
import { EMBEDDING_DIMENSIONS, embed, SearchServiceError, vectorDelete, vectorQuery, vectorUpsert } from "./cloudflare-ai";

type Call = { url: string; init: RequestInit };

function withCloudflare(responses: (() => Response)[], run: (calls: Call[]) => Promise<void>) {
  return async () => {
    const saved = { fetch: globalThis.fetch, account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_AI_API_TOKEN, index: process.env.VECTORIZE_INDEX };
    process.env.CLOUDFLARE_ACCOUNT_ID = "account";
    process.env.CLOUDFLARE_AI_API_TOKEN = "token";
    delete process.env.VECTORIZE_INDEX;
    const calls: Call[] = [];
    globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      return next();
    }) as typeof fetch;
    try {
      await run(calls);
    } finally {
      globalThis.fetch = saved.fetch;
      for (const [key, value] of [["CLOUDFLARE_ACCOUNT_ID", saved.account], ["CLOUDFLARE_AI_API_TOKEN", saved.token], ["VECTORIZE_INDEX", saved.index]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

const ok = (result: unknown) => () => Response.json({ success: true, errors: [], messages: [], result });
const vector = (value: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => value);

test("embed posts text batches to bge-m3 and retries 429 responses", withCloudflare([
  () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
  ok({ shape: [2, EMBEDDING_DIMENSIONS], data: [vector(0.1), vector(0.2)], pooling: "cls" }),
], async (calls) => {
  const vectors = await embed(["een", "twee"]);
  assert.equal(vectors.length, 2);
  assert.equal(vectors[1][0], 0.2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://api.cloudflare.com/client/v4/accounts/account/ai/run/@cf/baai/bge-m3");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { text: ["een", "twee"] });
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), "Bearer token");
  assert.ok(calls[1].init.signal, "every call is bounded by a timeout");
}));

test("responses that fail validation are rejected without echoing the body", withCloudflare([
  ok({ data: [[1, 2, 3]] }),
], async () => {
  await assert.rejects(embed(["secret file text"]), (error: unknown) => error instanceof SearchServiceError && !error.message.includes("secret"));
}));

test("a wrong embedding count is an error", withCloudflare([ok({ data: [vector(1)] })], async () => {
  await assert.rejects(embed(["a", "b"]), SearchServiceError);
}));

test("client errors are not retried, server errors give up after bounded attempts", withCloudflare([
  () => Response.json({ success: false, errors: [{ code: 1000, message: "bad" }] }, { status: 400 }),
  ...Array.from({ length: 4 }, () => () => new Response("", { status: 503, headers: { "retry-after": "0" } })),
], async (calls) => {
  await assert.rejects(vectorQuery(vector(0), 10), /status 400/);
  assert.equal(calls.length, 1);
  await assert.rejects(vectorDelete(["a"]), /status 503/);
  assert.equal(calls.length, 5);
}));

test("vector mutations and queries use the Vectorize v2 REST shapes", withCloudflare([
  ok({ mutationId: "m1" }),
  ok({ count: 1, matches: [{ id: "chunk-1", score: 0.8 }] }),
  ok({ mutationId: "m2" }),
], async (calls) => {
  await vectorUpsert([{ id: "chunk-1", values: [1, 2] }, { id: "chunk-2", values: [3, 4] }]);
  assert.match(calls[0].url, /vectorize\/v2\/indexes\/orole-drive-search\/upsert$/);
  assert.equal(new Headers(calls[0].init.headers).get("content-type"), "application/x-ndjson");
  assert.deepEqual(String(calls[0].init.body).split("\n").map((line) => JSON.parse(line)), [{ id: "chunk-1", values: [1, 2] }, { id: "chunk-2", values: [3, 4] }]);
  assert.deepEqual(await vectorQuery([1, 2], 500), [{ id: "chunk-1", score: 0.8 }]);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { vector: [1, 2], topK: 100, returnMetadata: "none", returnValues: false });
  await vectorDelete(["chunk-1"]);
  assert.match(calls[2].url, /delete_by_ids$/);
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { ids: ["chunk-1"] });
}));

test("unconfigured search never calls the network", async () => {
  const saved = process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  try {
    await assert.rejects(embed(["x"]), /not configured/);
  } finally {
    if (saved !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = saved;
  }
});
