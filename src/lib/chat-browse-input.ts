import { z } from "zod";

/** Half-open UTC instants: an end at midnight excludes that day, not its first millisecond. */
export const chatDateRangeFields = {
  since: z.iso.datetime({ offset: true }).optional().describe("Inclusive ISO timestamp with timezone; omit for no start bound."),
  until: z.iso.datetime({ offset: true }).optional().describe("Exclusive ISO timestamp with timezone; use the next midnight to include a whole day."),
};

export function validChatDateRange(input: { since?: string; until?: string }): boolean {
  return !input.since || !input.until || Date.parse(input.since) < Date.parse(input.until);
}

export const chatDateRangeError = { message: "The end timestamp must be after the start timestamp.", path: ["until"] };
