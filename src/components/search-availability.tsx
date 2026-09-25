"use client";

import { createContext, useContext } from "react";

/** Server configuration, decided once per page: search needs Cloudflare, chat also needs OpenRouter. */
export type SearchAvailability = { search: boolean; chat: boolean };

const SearchAvailabilityContext = createContext<SearchAvailability>({ search: false, chat: false });

export const SearchAvailabilityProvider = SearchAvailabilityContext.Provider;

export function useSearchAvailability(): SearchAvailability {
  return useContext(SearchAvailabilityContext);
}
