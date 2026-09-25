import "server-only";

import { and, eq, gt, sql } from "drizzle-orm";
import type { JWTPayload } from "jose";
import { isVerifiedFamilyUser } from "@/lib/auth-policy";
import { session as authSession, user as authUser } from "@/lib/auth-schema";
import { getDb } from "@/lib/db";
import type { DriveActor, DriveCapability } from "@/lib/drive-access";

/** Thrown for a verified access token that still can't be mapped to drive access; the
 * MCP route answers with an ordinary 403 rather than a scope-based challenge, matching
 * the oauth-provider docs' guidance that a denial the client can't fix by re-authorizing
 * should not use the `insufficient_scope` challenge machinery. */
export class McpAuthError extends Error {}

const SCOPE_CAPABILITIES: Record<string, DriveCapability> = {
  "mcp:read": "read",
  "mcp:write": "write",
  "mcp:share": "share",
  "mcp:trash": "trash",
};

export function scopesFromClaims(claims: JWTPayload): string[] {
  const scope = claims.scope;
  return typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [];
}

// requireMcpAuth's `requiredScopes: ["mcp:read"]` already rejects any token missing
// mcp:read before this runs, so every actor built here always has "read".
function capabilitiesFromScopes(scopes: readonly string[]): Set<DriveCapability> {
  const capabilities = new Set<DriveCapability>();
  for (const scope of scopes) {
    const capability = SCOPE_CAPABILITIES[scope];
    if (capability) capabilities.add(capability);
  }
  return capabilities;
}

export function oauthQueryFromSearchParams(params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, entry);
  }
  return query.has("sig") && query.has("client_id") ? query.toString() : "";
}
export async function resolveDriveActor(claims: JWTPayload): Promise<DriveActor> {
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const sessionId = typeof claims.sid === "string" ? claims.sid : "";
  if (!userId || !sessionId) throw new McpAuthError("Reconnect this assistant using a signed-in family session.");
  const capabilities = capabilitiesFromScopes(scopesFromClaims(claims));

  const [row] = await getDb().select({ email: authUser.email, emailVerified: authUser.emailVerified })
    .from(authSession).innerJoin(authUser, eq(authUser.id, authSession.userId)).where(and(
      eq(authSession.id, sessionId),
      eq(authSession.userId, userId),
      gt(authSession.expiresAt, sql`clock_timestamp()`),
    )).limit(1);
  if (!row || !isVerifiedFamilyUser(row)) throw new McpAuthError("This sign-in has expired or been revoked. Reconnect the assistant.");

  return { context: { sessionId, userId, email: row.email }, capabilities };
}
