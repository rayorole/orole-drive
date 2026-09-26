import type { DriveContext } from "@/lib/drive-access";
import type { DriveChatStep } from "@/lib/drive-types";

/** Shared execution hooks keep streamed steps and source numbers consistent across tools. */
export type ChatToolContext = {
  ctx: DriveContext;
  chatId: string;
  assistantMessageId: string;
  signal: AbortSignal;
  attachments: { id: string; name: string; size: number; mimeType: string; sha256: string }[];
  contentSourceIds: () => string[];
  cite: (itemId: string, name: string, location: string | null, quote: string | null, path: string[]) => number;
  run: (tool: DriveChatStep["tool"], label: string, work: (id: string) => Promise<{ result: string; update?: Partial<DriveChatStep> }>) => Promise<string>;
  mentionedOwner: (ownerId?: string) => { id: string; name: string } | undefined;
};
