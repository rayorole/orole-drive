"use client";

import { useQuery } from "@tanstack/react-query";
import { getSearchStatus } from "@/lib/drive-read-client";
import type { SearchIndexStatus } from "@/lib/drive-types";

const skipLabels: Record<NonNullable<SearchIndexStatus["skipReason"]>, string> = {
  too_large: "too large", unsupported: "file type not supported", excluded: "folder excluded",
  protected: "password-protected folder", empty: "no text found", trashed: "in Trash",
};

function label(status: SearchIndexStatus): string {
  if (status.state === "skipped") return `Skipped (${status.skipReason ? skipLabels[status.skipReason] : "not indexed"})`;
  return { queued: "Queued", indexing: "Indexing…", indexed: "Indexed", failed: "Failed, will retry", not_indexed: "Not indexed yet" }[status.state];
}

/** One line in Details: where a file stands in AI search. Hidden when search is off. */
export function SearchStatusLine({ itemId }: { itemId: string }) {
  const { data } = useQuery({
    queryKey: ["search-status", itemId],
    queryFn: async ({ signal }) => {
      const result = await getSearchStatus(itemId, signal);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    staleTime: 10_000,
    retry: false,
    refetchInterval: (query) => query.state.data?.state === "queued" || query.state.data?.state === "indexing" ? 5_000 : false,
  });
  if (!data) return null;
  return <p className="text-sm" aria-live="polite">{label(data)}</p>;
}
