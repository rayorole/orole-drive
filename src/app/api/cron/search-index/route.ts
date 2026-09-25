import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { runSearchSweep } from "@/lib/search-index";

export const runtime = "nodejs";
export const maxDuration = 300;

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) {
    return Response.json({ error: "Scheduled indexing is not configured." }, { status: 503, headers });
  }

  // Fixed-size digests let timingSafeEqual compare even different-length inputs.
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const supplied = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
  if (!timingSafeEqual(supplied, expected)) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers });
  }

  try {
    // Leases and per-attempt backoff make a timed-out run safe to resume on the next schedule.
    return Response.json(await runSearchSweep({ budgetMs: 270_000 }), { headers });
  } catch {
    return Response.json({ error: "Scheduled indexing failed." }, { status: 500, headers });
  }
}

// Do not let Next's automatic HEAD-to-GET fallback start an indexing run.
export function HEAD() {
  return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
}
