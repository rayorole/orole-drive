import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { purgeExpiredTrash } from "@/lib/trash";

export const runtime = "nodejs";
export const maxDuration = 300;

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) {
    return Response.json({ error: "Scheduled cleanup is not configured." }, { status: 503, headers });
  }

  // Fixed-size digests let timingSafeEqual compare even different-length inputs.
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const supplied = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
  if (!timingSafeEqual(supplied, expected)) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers });
  }

  try {
    // The purge is bounded to four leaf batches; committed deletion tombstones
    // survive storage failures or function timeouts for the next daily retry.
    // It also drops activity history older than a year.
    return Response.json(await purgeExpiredTrash(), { headers });
  } catch {
    return Response.json({ error: "Scheduled cleanup failed." }, { status: 500, headers });
  }
}

// Do not let Next's automatic HEAD-to-GET fallback start a deletion run.
export function HEAD() {
  return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
}
