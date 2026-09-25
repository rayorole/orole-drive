import { z } from "zod";

/** Exact email domains permitted to join and access the drive. */
export const EMAIL_DOMAIN_WHITELIST = ["orole.be", "ronzani.be"] as const;
const allowedEmailDomains = new Set<string>(EMAIL_DOMAIN_WHITELIST);

const emailSchema = z.email().max(254);

export function normalizeFamilyEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) return null;
  return allowedEmailDomains.has(email.split("@")[1]) ? email : null;
}

export function isVerifiedFamilyUser(user: { email: string; emailVerified: boolean }): boolean {
  return user.emailVerified === true && normalizeFamilyEmail(user.email) !== null;
}

export class FamilyAuthError extends Error {
  constructor(message = "Sign in with an approved email address to continue.") {
    super(message);
    this.name = "FamilyAuthError";
  }
}
