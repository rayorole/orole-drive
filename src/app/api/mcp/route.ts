import "server-only";

import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { getAuth } from "@/lib/auth";
import { McpAuthError, resolveDriveActor, scopesFromClaims } from "@/lib/mcp-auth";
import { createDriveMcpServer } from "@/lib/mcp-server";
import type { DriveActor } from "@/lib/drive-access";

// Deferred to first request (not module load) so a missing secret/DB/URL env var
// fails the same way every other auth.ts consumer does — at request time, never
// during `next build`'s module evaluation.
let handler: ((request: Request) => Promise<Response>) | undefined;

function getHandler() {
  if (handler) return handler;
  const auth = getAuth();
  const resource = new URL("/api/mcp", auth.options.baseURL as string).toString();
  const mcpHandler = createMcpHandler(
    (ctx) => {
      const actor = ctx.authInfo?.extra?.actor as DriveActor | undefined;
      if (!actor) throw new Error("Missing authenticated drive context.");
      return createDriveMcpServer(actor);
    },
    // Accept only the 2026-07-28 stateless per-request protocol; no 2025 session serving.
    { legacy: "reject" },
  );
  handler = requireMcpAuth(
    auth,
    async (request, accessTokenClaims) => {
      let actor: DriveActor;
      try {
        actor = await resolveDriveActor(accessTokenClaims);
      } catch (error) {
        if (error instanceof McpAuthError) return Response.json({ error: error.message }, { status: 403 });
        throw error;
      }
      const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const authInfo: AuthInfo = {
        token: bearer,
        clientId: typeof accessTokenClaims.client_id === "string" ? accessTokenClaims.client_id
          : typeof accessTokenClaims.azp === "string" ? accessTokenClaims.azp : "",
        scopes: scopesFromClaims(accessTokenClaims),
        expiresAt: typeof accessTokenClaims.exp === "number" ? accessTokenClaims.exp : undefined,
        extra: { actor },
      };
      return mcpHandler.fetch(request, { authInfo });
    },
    {
      resource,
      // Every tool defaults to read; write/share/trash tools additionally require their
      // own mcp:* scope via requireScopes() in mcp-server.ts, checked per call.
      requiredScopes: ["mcp:read"],
    },
  );
  return handler;
}

async function POST(request: Request) {
  return getHandler()(request);
}

export { POST };
