import "server-only";

import { answerChatTurn, startChatTurn } from "@/lib/chat";
import type { ChatTurn } from "@/lib/chat";
import { driveAction } from "@/lib/drive-access";
import type { DriveContext } from "@/lib/drive-access";
import { isTrustedDriveRequest } from "@/lib/drive-request";
import { isChatConfigured } from "@/lib/search-config";

export const runtime = "nodejs";
export const maxDuration = 120;

const headers = { "Cache-Control": "private, no-store, max-age=0", "Vary": "Cookie, Origin" };

// Same browser-only guard and session authorization as the read route; the answer then streams as NDJSON.
export async function POST(request: Request) {
  if (!isTrustedDriveRequest(request, "x-orole-chat")) {
    return Response.json({ success: false, error: "This request must come from the drive. Refresh and try again." }, { status: 403, headers });
  }
  if (!isChatConfigured()) return Response.json({ success: false, error: "Ask your drive is not set up." }, { status: 404, headers });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Check the information and try again." }, { status: 400, headers });
  }
  // The question is saved before streaming, so it survives a dropped connection.
  const started = await driveAction(async (ctx): Promise<{ ctx: DriveContext; turn: ChatTurn }> => ({ ctx, turn: await startChatTurn(ctx, body, request.signal) }), "read");
  if (!started.success) return Response.json(started, { status: 400, headers });
  return new Response(answerChatTurn(started.data.ctx, started.data.turn, request.signal), {
    headers: { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" },
  });
}
