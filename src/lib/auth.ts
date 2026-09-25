import "server-only";

import { createHash, createHmac } from "node:crypto";
import { cache } from "react";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getSessionCookie } from "better-auth/cookies";
import { nextCookies } from "better-auth/next-js";
import { emailOTP, jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { lt, lte, or, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { Resend } from "resend";
import * as schema from "@/lib/auth-schema";
import { FamilyAuthError, isVerifiedFamilyUser, normalizeFamilyEmail } from "@/lib/auth-policy";
import { getDb } from "@/lib/db";
import * as mcpSchema from "@/lib/mcp-schema";
import { McpAuthError, resolveDriveActor } from "@/lib/mcp-auth";

export { FamilyAuthError } from "@/lib/auth-policy";

// Request-scoped memoization keeps configuration lazy, including during builds.
export const getAuth = cache(() => {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new FamilyAuthError("Sign-in is not configured. Ask the drive administrator to set BETTER_AUTH_SECRET (at least 32 characters).");
  }
  if (!process.env.DATABASE_URL) {
    throw new FamilyAuthError("Sign-in is not configured. Ask the drive administrator to set DATABASE_URL and apply the database migrations.");
  }
  const baseURL = process.env.BETTER_AUTH_URL ?? (process.env.NODE_ENV === "production" ? undefined : "http://localhost:3000");
  if (!baseURL) {
    throw new FamilyAuthError("Sign-in is not configured. Ask the drive administrator to set BETTER_AUTH_URL to this site's address.");
  }
  const mcpResource = new URL("/api/mcp", baseURL).toString();

  return betterAuth({
    appName: "Orole Drive",
    baseURL,
    secret,
    database: drizzleAdapter(getDb(), { provider: "pg", schema: { ...schema, ...mcpSchema }, transaction: true }),
    emailAndPassword: { enabled: false },
    disabledPaths: ["/token"],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Reject raw OTP requests before storage/delivery; delivery callbacks can run in the background.
        if (ctx.path === "/email-otp/send-verification-otp" || ctx.path === "/sign-in/email-otp") {
          const email = normalizeFamilyEmail(ctx.body?.email);
          if (!email) throw new APIError("FORBIDDEN", { message: "Sign in with an approved email address." });
          ctx.body.email = email;
        }
        // Client registration capabilities are not a default authorization grant.
        if (ctx.path === "/oauth2/authorize") {
          const params = ctx.method === "POST" ? ctx.body : ctx.query;
          if (params && !params.scope) params.scope = "mcp:read";
        }
        if (ctx.path === "/oauth2/token") {
          // Require a resource-bound JWT on every exchange, including refresh;
          // the provider's opaque-token path does not run access-token claims.
          const resource = ctx.body?.resource;
          if (resource !== mcpResource && !(Array.isArray(resource) && resource.length === 1 && resource[0] === mcpResource)) {
            throw new APIError("BAD_REQUEST", { error: "invalid_target", error_description: `Use ${mcpResource} as the resource.` });
          }
        }
      }),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      cookiePrefix: "orole",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const email = normalizeFamilyEmail(user.email);
            if (!email || !user.emailVerified) {
              throw new APIError("FORBIDDEN", { message: "A verified email from an approved domain is required." });
            }
            return { data: { ...user, email } };
          },
        },
        update: {
          before: async (user) => {
            if (user.email === undefined) return;
            const email = normalizeFamilyEmail(user.email);
            if (!email) throw new APIError("FORBIDDEN", { message: "An email from an approved domain is required." });
            return { data: { ...user, email } };
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: {
          hash: async (otp) => createHmac("sha256", secret).update(otp).digest("hex"),
        },
        resendStrategy: "rotate",
        async sendVerificationOTP({ email: rawEmail, otp, type }) {
          const email = normalizeFamilyEmail(rawEmail);
          if (!email || type !== "sign-in") {
            throw new APIError("FORBIDDEN", { message: "Sign in with an approved email address." });
          }
          const apiKey = process.env.RESEND_API_KEY;
          const from = process.env.RESEND_FROM;
          if (!apiKey || !from) {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: "EMAIL_SETUP_REQUIRED",
              message: "Email delivery is not configured. Ask the drive administrator to set RESEND_API_KEY and RESEND_FROM with a verified sender.",
            });
          }
          let delivery;
          try {
            delivery = await new Resend(apiKey).emails.send({
              from,
              to: email,
              subject: "Your Orole Drive sign-in code",
              text: `Your Orole Drive sign-in code is ${otp}.\n\nIt expires in 10 minutes and can only be used once. Never share this code.\n\nIf you didn't request it, you can ignore this email.`,
            });
          } catch {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: "EMAIL_DELIVERY_UNAVAILABLE",
              message: "We couldn't reach the email service. Wait a minute and try again. If this continues, contact the drive administrator.",
            });
          }
          if (delivery.error) {
            const configurationProblem = ["validation_error", "missing_api_key", "invalid_api_key", "restricted_api_key", "not_found"].includes(delivery.error.name);
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: "EMAIL_DELIVERY_UNAVAILABLE",
              message: configurationProblem
                ? "The email service rejected this message. Ask the drive administrator to check the Resend API key, verified sender domain, and recipient permissions."
                : "The email service couldn't accept your message. Wait a minute and try again. If this continues, contact the drive administrator.",
            });
          }
        },
      }),
      jwt(),
      mcp({
        loginPage: "/login",
        consentPage: "/mcp/consent",
        resource: mcpResource,
        scopes: ["openid", "profile", "offline_access", "mcp:read", "mcp:write", "mcp:share", "mcp:trash"],
        grantTypes: ["authorization_code", "refresh_token"],
        clientRegistrationDefaultScopes: ["mcp:read"],
        clientRegistrationAllowedScopes: ["openid", "profile", "offline_access", "mcp:write", "mcp:share", "mcp:trash"],
        clientRegistrationRequirePKCE: true,
        allowPublicClientPrelogin: true,
        refreshTokenReuseInterval: 0,
        extensions: [{
          claims: {
            // The provider owns sid issuance. Unlike its default offline-access
            // policy, this drive requires the original browser session to live.
            async accessToken({ user, sessionId, scopes }) {
              try {
                await resolveDriveActor({ sub: user?.id, sid: sessionId, scope: scopes.join(" ") });
              } catch (error) {
                if (!(error instanceof McpAuthError)) throw error;
                throw new APIError("BAD_REQUEST", { error: "invalid_grant", error_description: error.message });
              }
              return {};
            },
          },
        }],
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      nextCookies(),
    ],
  });
});

export const getSession = cache(async () => {
  const requestHeaders = await headers();
  if (!getSessionCookie(requestHeaders, { cookiePrefix: "orole" })) return null;
  const authSession = await getAuth().api.getSession({ headers: requestHeaders });
  return authSession && isVerifiedFamilyUser(authSession.user) ? authSession : null;
});

export async function requireFamily() {
  const authSession = await getSession();
  if (!authSession) throw new FamilyAuthError();
  return authSession;
}

export async function consumeAuthAttempt(email: string, operation: "send" | "verify") {
  const subject = createHash("sha256").update(email).digest("hex");
  const limits = operation === "send"
    ? [
        { key: "send:global", seconds: 3600, max: 100, message: "The family drive has sent too many codes. Please try again in an hour." },
        { key: `send:cooldown:${subject}`, seconds: 60, max: 1, message: "Please wait one minute before requesting another code." },
        { key: `send:email:${subject}`, seconds: 900, max: 5, message: "Too many code requests. Please wait 15 minutes and try again." },
      ]
    : [{ key: `verify:${subject}`, seconds: 600, max: 5, message: "Too many sign-in attempts. Please wait 10 minutes, then request a new code." }];

  // Conditional upserts lock each bucket across processes; no read/increment race.
  await getDb().transaction(async (tx) => {
    for (const limit of limits) {
      const expired = lte(schema.authThrottle.windowStartedAt, sql`now() - ${limit.seconds} * interval '1 second'`);
      const [claimed] = await tx.insert(schema.authThrottle)
        .values({ key: limit.key, count: 1 })
        .onConflictDoUpdate({
          target: schema.authThrottle.key,
          set: {
            count: sql`case when ${expired} then 1 else ${schema.authThrottle.count} + 1 end`,
            windowStartedAt: sql`case when ${expired} then now() else ${schema.authThrottle.windowStartedAt} end`,
          },
          setWhere: or(expired, lt(schema.authThrottle.count, limit.max)),
        })
        .returning({ key: schema.authThrottle.key });
      if (!claimed) throw new FamilyAuthError(limit.message);
    }
  });
}
