import "server-only";

import { getAuthHandlers } from "@/lib/auth-handler";

// The drive's own UI never calls these directly (it uses server actions calling
// auth.api.* in src/app/actions/auth.ts). This mount exists because the mcp()/jwt()/
// cimd() plugins are only reachable as real HTTP endpoints — MCP clients redirect
// browsers to /api/auth/oauth2/authorize, POST to /api/auth/oauth2/token, fetch
// /api/auth/jwks, and go through /api/auth/oauth2/consent — none of which an external
// OAuth client can reach through a Next.js server action.

export async function GET(request: Request) {
  return getAuthHandlers().GET(request);
}

export async function POST(request: Request) {
  return getAuthHandlers().POST(request);
}

export async function PATCH(request: Request) {
  return getAuthHandlers().PATCH(request);
}

export async function PUT(request: Request) {
  return getAuthHandlers().PUT(request);
}

export async function DELETE(request: Request) {
  return getAuthHandlers().DELETE(request);
}
