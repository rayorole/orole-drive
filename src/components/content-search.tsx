"use client";

import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, TextSearch } from "lucide-react";
import { searchContents } from "@/lib/drive-read-client";
import type { DriveItem, SemanticSearchHit } from "@/lib/drive-types";
import { DriveFileIcon } from "@/components/drive-item";
import { Hint, TruncatedText } from "@/components/hint";
import { Spinner } from "@/components/spinner";

export const CONTENT_SEARCH_MIN_CHARS = 3;

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wraps query terms in <mark>. React escapes every text segment, so file text can never become markup. */
export function Highlighted({ text, query }: { text: string; query: string }) {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? [])].filter((term) => term.length > 1);
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "giu");
  return <>{text.split(pattern).map((part, index) => index % 2
    ? <mark key={index} className="rounded-sm bg-amber-200/70 px-0.5 text-foreground dark:bg-amber-400/30">{part}</mark>
    : <Fragment key={index}>{part}</Fragment>)}</>;
}

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** "Found inside files": content matches under the name results, re-authorized by the server on every query. */
export function FoundInsideFiles({ query, onOpen, onShowFolder }: {
  query: string;
  onOpen: (item: DriveItem) => void;
  onShowFolder: (folderId: string | null) => void;
}) {
  const debounced = useDebounced(query.trim(), 300);
  // Like name search, content search spans every accessible folder.
  const folderId = null;
  const enabled = debounced.length >= CONTENT_SEARCH_MIN_CHARS;
  const results = useQuery({
    queryKey: ["semantic-search", debounced, folderId],
    queryFn: async ({ signal }) => {
      const result = await searchContents({ query: debounced, folderId, limit: 10 }, signal);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  if (!enabled) return null;
  const hits = results.data?.results ?? [];
  return <section aria-labelledby="found-inside-files" className="mt-6 flex flex-col gap-2">
    <div className="flex items-center gap-2 px-1">
      <TextSearch className="size-4 text-muted-foreground" aria-hidden="true" />
      <h2 id="found-inside-files" className="text-sm font-medium">Found inside files</h2>
      {results.isFetching && <Spinner size={14} label="Searching inside files" />}
      {results.data?.degraded && <span className="text-xs text-muted-foreground">Showing keyword matches only</span>}
    </div>
    {results.isError ? <p role="alert" className="px-1 text-sm text-destructive">{results.error.message}</p>
      : results.isPending ? null
      : hits.length ? <ul className="-mx-1 flex flex-col" aria-live="polite">{hits.map((hit) => <ContentHit key={hit.item.id} hit={hit} query={debounced} onOpen={onOpen} onShowFolder={onShowFolder} />)}</ul>
      : <p className="px-1 text-sm text-muted-foreground">No matches inside files</p>}
  </section>;
}

function ContentHit({ hit, query, onOpen, onShowFolder }: { hit: SemanticSearchHit; query: string; onOpen: (item: DriveItem) => void; onShowFolder: (folderId: string | null) => void }) {
  const passage = hit.passages[0];
  const where = hit.path.length ? hit.path.join(" / ") : hit.folderId ? "Shared folder" : "All files";
  return <li className="group relative flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted">
    <DriveFileIcon item={hit.item} />
    <button type="button" onClick={() => onOpen(hit.item)} className="min-w-0 flex-1 rounded-md text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring after:rounded-lg"
      aria-label={`Preview ${hit.item.name}, in ${where}`}>
      <span className="flex min-w-0 items-baseline gap-2">
        <TruncatedText className="min-w-0 text-sm font-medium">{hit.item.name}</TruncatedText>
        <TruncatedText className="min-w-0 shrink text-xs text-muted-foreground">{where}</TruncatedText>
      </span>
      {passage && <span className="mt-0.5 flex min-w-0 items-start gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 text-xs leading-5 text-muted-foreground"><Highlighted text={passage.text} query={query} /></span>
        {passage.location && <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground ring-1 ring-border">{passage.location}</span>}
      </span>}
    </button>
    <Hint label="Show in folder">
      <button type="button" onClick={() => onShowFolder(hit.folderId)} aria-label={`Show ${hit.item.name} in its folder`}
        className="relative z-10 mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <FolderOpen className="size-4" />
      </button>
    </Hint>
  </li>;
}
