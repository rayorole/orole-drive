import "server-only";

import { driveAction } from "@/lib/drive-access";
import { loadChatImage } from "@/lib/chat-reader-access";

export const runtime = "nodejs";

/** No signed link or original active content escapes; every fetch checks current AI permissions. */
export async function GET(request: Request, context: { params: Promise<{ itemId: string }> }) {
  const headers = {
    "Cache-Control": "private, no-store, max-age=0",
    "Vary": "Cookie",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (request.headers.get("sec-fetch-site") === "cross-site") return new Response(null, { status: 403, headers });
  const { itemId } = await context.params;
  const result = await driveAction((ctx) => loadChatImage(ctx, itemId, request.signal), "read");
  if (!result.success) return new Response(null, { status: 404, headers });
  return new Response(new Uint8Array(result.data.data), {
    headers: { ...headers, "Content-Type": "image/jpeg", "Content-Disposition": "inline" },
  });
}
