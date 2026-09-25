import "server-only";

import { getAuthHandlers } from "@/lib/auth-handler";

// RFC 9728 metadata for the canonical /api/mcp protected resource.
export async function GET(request: Request) {
  return getAuthHandlers().GET(request);
}
