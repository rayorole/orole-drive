import { z } from "zod";

const emailSchema = z.email().max(254);

export function normalizeFamilyEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) return null;
  return email.split("@")[1] === "orole.be" ? email : null;
}

export function isVerifiedFamilyUser(user: { email: string; emailVerified: boolean }): boolean {
  return user.emailVerified === true && normalizeFamilyEmail(user.email) !== null;
}

export class FamilyAuthError extends Error {
  constructor(message = "Sign in with your @orole.be email to continue.") {
    super(message);
    this.name = "FamilyAuthError";
  }
}
