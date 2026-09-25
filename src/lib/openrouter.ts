import "server-only";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { searchConfig } from "@/lib/search-config";

export const CAPTION_PROMPT = "Describe this image for search in 2–4 sentences (people count, setting, objects, activity, season/occasion) and transcribe any clearly visible text. Do not guess identities.";

/** Null when OpenRouter is not configured; image captions and chat then stay off. */
export function openRouterModel(kind: "caption" | "chat") {
  const config = searchConfig();
  if (!config?.openRouterKey) return null;
  const provider = createOpenRouter({ apiKey: config.openRouterKey, appName: "Orole Drive" });
  return provider(kind === "caption" ? config.captionModel : config.chatModel);
}

export type ImageCaptioner = (image: { data: Uint8Array; mediaType: string }, signal: AbortSignal) => Promise<string>;

export const captionImage: ImageCaptioner = async (image, signal) => {
  const model = openRouterModel("caption");
  if (!model) throw new Error("Image captions are not configured.");
  const { text } = await generateText({
    model, maxOutputTokens: 400, maxRetries: 2, abortSignal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    messages: [{ role: "user", content: [{ type: "text", text: CAPTION_PROMPT }, { type: "file", mediaType: image.mediaType, data: image.data }] }],
  });
  return text.trim();
};
