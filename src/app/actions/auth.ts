"use server";

import { APIError } from "better-auth/api";
import { getSessionCookie } from "better-auth/cookies";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { consumeAuthAttempt, getAuth } from "@/lib/auth";
import { FamilyAuthError, normalizeFamilyEmail } from "@/lib/auth-policy";
import type { ActionResult } from "@/lib/drive-types";

function authError(error: unknown): { success: false; error: string } {
  if (error instanceof FamilyAuthError) return { success: false, error: error.message };
  if (error instanceof APIError) {
    const code = error.body?.code;
    if (code === "EMAIL_SETUP_REQUIRED" || code === "EMAIL_DELIVERY_UNAVAILABLE") {
      return { success: false, error: error.message };
    }
    if (code === "TOO_MANY_ATTEMPTS") {
      return { success: false, error: "Too many incorrect codes. Wait 10 minutes, then request a new code." };
    }
    if (code === "OTP_EXPIRED" || code === "INVALID_OTP" || code === "VERIFICATION_NOT_FOUND") {
      return { success: false, error: "That code is incorrect or has expired. Check the most recent email, or request a new code." };
    }
  }
  return { success: false, error: "Sign-in is temporarily unavailable. Try again shortly. If this continues, ask the drive administrator to check the database and email service." };
}

export async function requestCode(rawEmail: string): Promise<ActionResult<void>> {
  const email = normalizeFamilyEmail(rawEmail);
  if (!email) return { success: false, error: "Use an email address from an approved domain to sign in." };
  try {
    const auth = getAuth();
    await consumeAuthAttempt(email, "send");
    await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers: await headers(),
    });
    return { success: true, data: undefined };
  } catch (error) {
    return authError(error);
  }
}

export async function verifyCode(rawEmail: string, rawCode: string, oauthQuery = ""): Promise<ActionResult<{ redirectUrl?: string }>> {
  const email = normalizeFamilyEmail(rawEmail);
  if (!email) return { success: false, error: "Use an email address from an approved domain to sign in." };
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (!/^\d{6}$/.test(code)) return { success: false, error: "Enter the six-digit code from your email." };
  try {
    const auth = getAuth();
    await consumeAuthAttempt(email, "verify");
    if (typeof oauthQuery !== "string" || oauthQuery.length > 16_384) throw new FamilyAuthError("This authorization request is invalid. Restart the assistant connection.");
    const requestHeaders = new Headers(await headers());
    requestHeaders.set("accept", "application/json");
    // The provider validates the signed query before sign-in and resumes
    // authorization in its post-login hook; never navigate to a caller's URL.
    const body = { email, otp: code, name: email.split("@")[0], ...(oauthQuery ? { oauth_query: oauthQuery } : {}) };
    const result: unknown = await auth.api.signInEmailOTP({
      body, headers: requestHeaders, asResponse: false,
      // OAuth's post-login authorize endpoint requires an HTTP request context,
      // including when sign-in originates in a Next server action.
      request: new Request(new URL("/api/auth/sign-in/email-otp", auth.options.baseURL as string), { method: "POST", headers: requestHeaders }),
    });
    let redirectUrl: string | undefined;
    if (oauthQuery) {
      if (!result || typeof result !== "object" || !("url" in result) || typeof result.url !== "string") {
        throw new FamilyAuthError("Sign-in succeeded, but authorization could not continue. Restart the assistant connection.");
      }
      redirectUrl = result.url;
    }
    revalidatePath("/", "layout");
    return { success: true, data: { redirectUrl } };
  } catch (error) {
    return authError(error);
  }
}

export async function logout(): Promise<never> {
  const requestHeaders = await headers();
  if (getSessionCookie(requestHeaders, { cookiePrefix: "orole" })) {
    await getAuth().api.signOut({ headers: requestHeaders });
  }
  revalidatePath("/", "layout");
  redirect("/login");
}
