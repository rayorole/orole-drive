import "server-only";

import { getAuthHandlers } from "@/lib/auth-handler";

// RFC 9728 requires this document at the bare site root, unreachable through the
// /api/auth/[...all] catch-all alone.
export async function GET(request: Request) {
  return getAuthHandlers().GET(request);
}
