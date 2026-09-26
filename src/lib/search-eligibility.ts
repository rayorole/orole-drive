import type { SearchSkipReason } from "./search-schema";

/** The fields of an item and its ancestors that decide whether its contents may be searched. */
export interface SearchNode {
  id: string;
  parentId: string | null;
  kind: "file" | "folder";
  state: "pending" | "complete";
  trashed: boolean;
  deleting: boolean;
  hasPassword: boolean;
  searchExcluded: boolean;
}

export type SearchEligibility = { eligible: true } | { eligible: false; reason: SearchSkipReason };

/**
 * A complete item may be disclosed to AI unless it or any ancestor is in Trash or being deleted,
 * is password-protected (even while unlocked), or was excluded from AI search.
 * A broken or unreachable ancestry counts as unavailable. Folders need no content index.
 */
export function searchMetadataEligibility(nodes: ReadonlyMap<string, SearchNode>, id: string): SearchEligibility {
  const path: SearchNode[] = [];
  const seen = new Set<string>();
  for (let cursor: string | null = id; cursor; ) {
    const node = nodes.get(cursor);
    if (!node || seen.has(cursor) || path.length > 64) return { eligible: false, reason: "trashed" };
    seen.add(cursor);
    path.push(node);
    cursor = node.parentId;
  }
  if (path.some((node) => node.trashed || node.deleting)) return { eligible: false, reason: "trashed" };
  if (path.some((node) => node.hasPassword)) return { eligible: false, reason: "protected" };
  if (path.some((node) => node.searchExcluded)) return { eligible: false, reason: "excluded" };
  if (path[0].state !== "complete" || path.slice(1).some((node) => node.kind !== "folder" || node.state !== "complete")) {
    return { eligible: false, reason: "unsupported" };
  }
  return { eligible: true };
}

/** Content indexing remains file-only; metadata discovery also supports folders. */
export function searchEligibility(nodes: ReadonlyMap<string, SearchNode>, id: string): SearchEligibility {
  const eligibility = searchMetadataEligibility(nodes, id);
  return eligibility.eligible && nodes.get(id)?.kind !== "file" ? { eligible: false, reason: "unsupported" } : eligibility;
}

export type CommitDecision = "commit" | "lost" | "stale" | { skip: SearchSkipReason };

/**
 * What to do with finished extraction work, decided under the hierarchy lock. A lost lease means
 * another run (or a newer enqueue) owns the document; a changed etag means the bytes were
 * replaced while extracting, so the stale text must never overwrite what is current.
 */
export function commitDecision(input: { leaseHeld: boolean; extractedEtag: string | null; currentEtag: string | null | undefined; eligibility: SearchEligibility }): CommitDecision {
  if (!input.leaseHeld) return "lost";
  if (!input.eligibility.eligible) return { skip: input.eligibility.reason };
  if (!input.extractedEtag || input.extractedEtag !== input.currentEtag) return "stale";
  return "commit";
}
