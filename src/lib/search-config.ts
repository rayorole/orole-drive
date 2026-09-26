import "server-only";

export type SearchConfig = {
  accountId: string;
  apiToken: string;
  index: string;
  openRouterKey: string;
  captionModel: string;
  chatModel: string;
};

const env = (name: string) => process.env[name]?.trim() || undefined;

/**
 * Null until Cloudflare credentials exist. Without them the drive behaves exactly as it did
 * before search: nothing is embedded, captioned or queried, and search UI stays hidden.
 */
export function searchConfig(): SearchConfig | null {
  const accountId = env("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = env("CLOUDFLARE_AI_API_TOKEN");
  if (!accountId || !apiToken) return null;
  return {
    accountId, apiToken,
    index: env("VECTORIZE_INDEX") ?? "orole-drive-search",
    openRouterKey: env("OPENROUTER_API_KEY") ?? "",
    captionModel: env("SEARCH_CAPTION_MODEL") ?? "anthropic/claude-haiku-4.5",
    chatModel: env("SEARCH_CHAT_MODEL") ?? "stealth/space-bunny-alpha",
  };
}

export function isSearchConfigured(): boolean {
  return searchConfig() !== null;
}

/** Image captions and chat need OpenRouter on top of the Cloudflare index. */
export function isChatConfigured(): boolean {
  return Boolean(searchConfig()?.openRouterKey);
}
