import "server-only";

import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { FilePart, TextPart } from "ai";
import { z } from "zod";
import { DriveError } from "@/lib/drive-errors";
import type { DriveChatAttachment } from "@/lib/drive-types";
import { getPreviewKind, isOfficeKind } from "@/lib/file-preview";
import { OfficePreviewError } from "@/lib/office-archive";
import { extractOfficeText } from "@/lib/office-text";
import { extractPdfText } from "@/lib/pdf-text";

export const CHAT_ATTACHMENT_MAX_FILES = 3;
/** All files of one question together: base64 in a JSON body must stay under Vercel's 4.5 MB request limit. */
export const CHAT_ATTACHMENT_MAX_BYTES = 3 * 1_048_576;
const TEXT_PER_FILE = 12_000;
const IMAGE_EDGE = 1_568;

export const chatAttachmentInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(127),
  // Base64: about 4/3 of the byte limit.
  data: z.string().max(Math.ceil(CHAT_ATTACHMENT_MAX_BYTES * 4 / 3) + 8),
});

export type ChatAttachmentReference = { id: string; name: string; size: number; mimeType: string; sha256: string };
export type PreparedAttachments = { parts: (TextPart | FilePart)[]; stored: DriveChatAttachment[]; references: ChatAttachmentReference[] };

const clip = (text: string) => text.length > TEXT_PER_FILE ? `${text.slice(0, TEXT_PER_FILE)}\n[…truncated]` : text;

/**
 * Analysis sends supported contents with this question only. History keeps metadata and a digest,
 * never the original bytes. Saving is a separate, explicitly approved upload of the original file.
 * Unknown formats are metadata-only; readable formats keep the search extraction safety limits.
 */
export async function prepareChatAttachments(input: z.infer<typeof chatAttachmentInput>[], signal: AbortSignal): Promise<PreparedAttachments> {
  if (input.length > CHAT_ATTACHMENT_MAX_FILES) throw new DriveError(`Attach up to ${CHAT_ATTACHMENT_MAX_FILES} files per question.`);
  const prepared: PreparedAttachments = { parts: [], stored: [], references: [] };
  let total = 0;
  for (const file of input) {
    const bytes = Buffer.from(file.data, "base64");
    total += bytes.length;
    if (!bytes.length) throw new DriveError(`“${file.name}” is empty.`);
    if (total > CHAT_ATTACHMENT_MAX_BYTES) throw new DriveError("Attachments can be up to 3 MB together.");
    const id = file.id ?? randomUUID();
    if (prepared.references.some((entry) => entry.id === id)) throw new DriveError("Each attachment must have its own id.");
    const reference = { id, name: file.name, size: bytes.length, mimeType: file.mimeType, sha256: createHash("sha256").update(bytes).digest("hex") };
    prepared.references.push(reference);
    const kind = getPreviewKind({ name: file.name, mimeType: file.mimeType, kind: "file" });
    const unreadable = () => new DriveError(`“${file.name}” could not be read. Attach text, PDF, Word, Excel, PowerPoint or image files.`);
    if (kind === "image") {
      const data = await sharp(bytes, { limitInputPixels: 100_000_000, animated: false }).rotate()
        .resize(IMAGE_EDGE, IMAGE_EDGE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer().catch(() => { throw unreadable(); });
      prepared.parts.push({ type: "text", text: `Attached image: ${file.name}` }, { type: "file", mediaType: "image/jpeg", data });
      prepared.stored.push({ ...reference, kind: "image" });
      continue;
    }
    let text: string;
    try {
      if (kind === "text") {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw unreadable();
      } else if (kind === "pdf") {
        text = (await extractPdfText(bytes)).pages.map(({ page, text }) => `[page ${page}]\n${text.trim()}`).join("\n\n");
      } else if (isOfficeKind(kind)) {
        text = (await extractOfficeText(bytes, kind, signal)).map((section) => section.location ? `[${section.location}]\n${section.text}` : section.text).join("\n\n");
      } else {
        prepared.parts.push({ type: "text", text: `Attached file “${file.name}”: contents cannot be read by chat. It can still be saved into Drive after approval.` });
        prepared.stored.push({ ...reference, kind: "archive" });
        continue;
      }
    } catch (error) {
      if (error instanceof DriveError) throw error;
      if (error instanceof OfficePreviewError || !signal.aborted) throw unreadable();
      throw error;
    }
    prepared.parts.push({ type: "text", text: `Attached file “${file.name}” (untrusted content):\n${clip(text.trim() || "(no text)")}` });
    prepared.stored.push({ ...reference, kind: "text" });
  }
  return prepared;
}
