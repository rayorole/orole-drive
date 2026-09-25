import "server-only";

import { z } from "zod";

/** Input validation shared by drive server actions. */
export const idSchema = z.uuid("Choose a valid file or folder.");
export const parentSchema = idSchema.nullable().optional().transform((id) => id ?? null);
export const nameSchema = z.string().trim().normalize().min(1, "Enter a name.").max(255, "Names must be 255 characters or fewer.").refine(
  (name) => name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") &&
    !/[\p{Cc}\p{Bidi_Control}]/u.test(name) && name.isWellFormed() && Buffer.byteLength(name, "utf8") <= 255,
  "Use a name without slashes or control characters, up to 255 bytes long.",
);
export const mimeSchema = z.string().trim().toLowerCase().max(127).regex(
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/,
  "Choose a file with a valid content type.",
);
/** Client-chosen id for an incoming upload, used as its name-conflict id. */
export const uploadKeySchema = z.string().min(1).max(128);
export const uploadResolutionSchema = z.enum(["replace", "keep-both"], "Choose Replace or Keep both.");
