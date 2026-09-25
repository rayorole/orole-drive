"use server";

import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { driveAction } from "@/lib/drive-access";
import type { ActionResult } from "@/lib/drive-types";
import { oauthAccessToken, oauthClient, oauthRefreshToken } from "@/lib/mcp-schema";

export type ConnectedAgents = { count: number; names: string[] };

/**
 * AI assistants the signed-in user has connected over MCP and not disconnected: a client with an
 * unrevoked, unexpired refresh token, or a stored access token (JWT access tokens aren't stored,
 * so the refresh token is what outlives a single request).
 */
export async function getConnectedAgents(): Promise<ActionResult<ConnectedAgents>> {
  return driveAction(async (ctx) => {
    const db = getDb();
    const [refresh, access] = await Promise.all([
      db.selectDistinct({ clientId: oauthRefreshToken.clientId }).from(oauthRefreshToken).where(and(
        eq(oauthRefreshToken.userId, ctx.userId), isNull(oauthRefreshToken.revoked), gt(oauthRefreshToken.expiresAt, sql`now()`),
      )),
      db.selectDistinct({ clientId: oauthAccessToken.clientId }).from(oauthAccessToken).where(and(
        eq(oauthAccessToken.userId, ctx.userId), isNull(oauthAccessToken.revoked), gt(oauthAccessToken.expiresAt, sql`now()`),
      )),
    ]);
    const clientIds = [...new Set([...refresh, ...access].map((row) => row.clientId))];
    if (!clientIds.length) return { count: 0, names: [] };
    const clients = await db.select({ clientId: oauthClient.clientId, name: oauthClient.name }).from(oauthClient)
      .where(and(eq(oauthClient.disabled, false), inArray(oauthClient.clientId, clientIds)));
    return { count: clients.length, names: clients.map((client) => client.name || "Unnamed assistant").sort() };
  }, "read");
}
