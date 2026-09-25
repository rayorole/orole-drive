import type { QueryClient } from "@tanstack/react-query";
import type { DriveItem, DriveListInput, DriveListing } from "@/lib/drive-types";

type DriveCacheChange =
  | { kind: "rename"; id: string; name: string }
  | { kind: "favorite"; ids: string[]; favorited: boolean }
  | { kind: "move" | "trash" | "restore"; ids: string[]; parentId?: string | null };

/** Existing rows only: server confirmation remains authoritative for new destinations and access. */
export async function optimisticDriveChange(client: QueryClient, change: DriveCacheChange): Promise<() => void> {
  await client.cancelQueries({ queryKey: ["drive"] });
  const snapshots = client.getQueriesData<DriveListing>({ queryKey: ["drive"] });
  const ids = new Set(change.kind === "rename" ? [change.id] : change.ids);
  if (change.kind !== "rename" && change.kind !== "favorite") {
    const knownItems = snapshots.flatMap(([, listing]) => listing?.items ?? []);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const item of knownItems) {
        if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
          ids.add(item.id);
          expanded = true;
        }
      }
    }
  }
  const applied: { key: readonly unknown[]; previous: DriveListing; next: DriveListing }[] = [];
  for (const [key, listing] of snapshots) {
    if (!listing) continue;
    const input = typeof key[1] === "object" && key[1] !== null ? key[1] as DriveListInput : undefined;
    const trashView = input?.filter === "trash";
    const rename = (item: DriveItem) => change.kind === "rename" && item.id === change.id ? { ...item, name: change.name }
      : change.kind === "favorite" && ids.has(item.id) ? { ...item, isFavorite: change.favorited } : item;
    const items = change.kind === "rename" ? listing.items.map(rename)
      // The Favorites view drops rows as soon as they are unstarred; every other view just updates the star.
      : change.kind === "favorite" ? (input?.filter === "favorites" && !change.favorited ? listing.items.filter((item) => !ids.has(item.id)) : listing.items.map(rename))
      : change.kind === "restore" && !trashView ? listing.items
      : listing.items.filter((item) => !ids.has(item.id));
    const next = {
      ...listing,
      items,
      currentFolder: listing.currentFolder ? rename(listing.currentFolder) : null,
      breadcrumbs: change.kind === "rename" ? listing.breadcrumbs.map((crumb) => crumb.id === change.id ? { ...crumb, name: change.name } : crumb) : listing.breadcrumbs,
    };
    const cached = client.setQueryData<DriveListing>(key, next);
    if (cached) applied.push({ key, previous: listing, next: cached });
  }
  return () => {
    // Never overwrite a newer server response or a subsequent optimistic transaction.
    for (const { key, previous, next } of applied) {
      if (client.getQueryData(key) === next) client.setQueryData(key, previous);
    }
  };
}
