import "server-only";

import { createHash, createHmac } from "node:crypto";
import { cache } from "react";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getSessionCookie } from "better-auth/cookies";
import { nextCookies } from "better-auth/next-js";
import { emailOTP } from "better-auth/plugins";
import { lt, lte, or, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { Resend } from "resend";
import * as schema from "@/lib/auth-schema";
import { FamilyAuthError, isVerifiedFamilyUser, normalizeFamilyEmail } from "@/lib/auth-policy";
import { getDb } from "@/lib/db";

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

  return betterAuth({
    appName: "Orole Drive",
    baseURL,
    secret,
    database: drizzleAdapter(getDb(), { provider: "pg", schema, transaction: true }),
    emailAndPassword: { enabled: false },
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
              throw new APIError("FORBIDDEN", { message: "A verified @orole.be email is required." });
            }
            return { data: { ...user, email } };
          },
        },
        update: {
          before: async (user) => {
            if (user.email === undefined) return;
            const email = normalizeFamilyEmail(user.email);
            if (!email) throw new APIError("FORBIDDEN", { message: "An @orole.be email is required." });
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
            throw new APIError("FORBIDDEN", { message: "Sign in with your @orole.be email." });
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
