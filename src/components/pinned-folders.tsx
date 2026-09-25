"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { Info, LockKeyhole, Pin, PinOff, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { setFolderPinned } from "@/app/actions/pinned-folders";
import { listPinnedFolders } from "@/lib/drive-read-client";
import type { DriveItem } from "@/lib/drive-types";
import { cn } from "@/lib/utils";
import { useFolderAccess, DriveAccessError } from "@/components/folder-access";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Hint } from "@/components/hint";
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/cubby-ui/context-menu";
import { DriveMetadataDialog } from "@/components/drive-metadata-ui";
import { FolderIcon } from "@/components/folder-icon";
import { SharingBadges } from "@/components/sharing-badges";

const pinsKey = ["drive", "pinned-folders"] as const;
interface PinsState {
  query: UseQueryResult<DriveItem[], Error>;
  mutation: UseMutationResult<DriveItem[], Error, { id: string; pinned: boolean }>;
  ids: ReadonlySet<string>;
}
const PinsContext = createContext<PinsState | null>(null);

function usePinsState() {
  const client = useQueryClient();
  const { run } = useFolderAccess();
  const query = useQuery({
    queryKey: pinsKey,
    queryFn: async ({ signal }) => {
      const result = await listPinnedFolders(signal);
      if (!result.success) throw new DriveAccessError(result.error, result.lockedFolder);
      return result.data;
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => run(() => setFolderPinned(id, pinned)),
    onSuccess: (folders, { pinned }) => {
      client.setQueryData(pinsKey, folders);
      toast.success(pinned ? "Folder pinned to sidebar" : "Folder unpinned from sidebar");
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => { void client.invalidateQueries({ queryKey: pinsKey }); },
  });
  const ids = useMemo(() => new Set(query.data?.map((item) => item.id)), [query.data]);
  return { query, mutation, ids };
}

export function PinnedFoldersProvider({ children }: { children: ReactNode }) {
  const value = usePinsState();
  return <PinsContext value={value}>{children}</PinsContext>;
}

export function usePinnedFolders() {
  const value = useContext(PinsContext);
  if (!value) throw new Error("Pinned folders need PinnedFoldersProvider.");
  return value;
}

export function PinnedFoldersNav({ collapsed, folderId, onOpen, disabled }: {
  collapsed: boolean;
  folderId?: string | null;
  onOpen: (folder: DriveItem) => void;
  disabled: boolean;
}) {
  const { query, mutation } = usePinnedFolders();
  const [details, setDetails] = useState<DriveItem | null>(null);
  const unpin = (item: DriveItem) => mutation.mutate({ id: item.id, pinned: false });
  return <section aria-label="Pinned folders" className="mt-5 flex flex-col gap-0.5">
    <h2 className={cn("mb-1 px-2 text-xs font-normal text-muted-foreground", collapsed && "sr-only")}>Pinned</h2>
    {query.isPending ? <div role="status" aria-label="Loading pinned folders" className="px-2 py-1"><Skeleton className="h-7 w-full" /></div>
      : query.error ? <Hint label={collapsed ? "Could not load pinned folders. Try again" : null} side="right"><Button variant="ghost" size={collapsed ? "icon" : "sm"} aria-label="Retry loading pinned folders" onClick={() => void query.refetch()}><TriangleAlert />{!collapsed && "Retry pinned folders"}</Button></Hint>
      : query.data?.length ? query.data.map((item) => <ContextMenu key={item.id}>
        <Hint label={collapsed ? item.name : null} side="right">
          <ContextMenuTrigger render={<button type="button" disabled={disabled} />} onClick={() => onOpen(item)} aria-label={`Open pinned folder ${item.name}`} aria-current={folderId === item.id ? "page" : undefined}
            className={cn("flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:min-h-11", collapsed && "justify-center px-0", folderId === item.id ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/65 hover:text-foreground")}>
            <span className="relative shrink-0"><FolderIcon item={item} compact />{item.isLocked && <LockKeyhole aria-label="Locked folder" className="absolute -left-1 -top-1 size-2.5" />}{collapsed && <span className="absolute -right-1.5 -top-1.5"><SharingBadges sharing={item.sharing} compact /></span>}</span>
            {!collapsed && <span className="truncate">{item.name}</span>}
            {!collapsed && <SharingBadges sharing={item.sharing} />}
          </ContextMenuTrigger>
        </Hint>
        <ContextMenuContent side="right">
          <ContextMenuGroup>
            <ContextMenuItem disabled={mutation.isPending} onClick={() => unpin(item)}><PinOff />Unpin from sidebar</ContextMenuItem>
            <ContextMenuItem disabled={disabled} onClick={() => setDetails(item)}><Info />Edit details</ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>)
        : <Hint label={collapsed ? "Pin folders from their Actions menu" : null} side="right">{collapsed ? <span tabIndex={0} aria-label="No pinned folders. Pin folders from their Actions menu" className="flex min-h-9 items-center justify-center text-muted-foreground"><Pin className="size-4" /></span> : <p className="px-2 py-1 text-xs leading-relaxed text-muted-foreground">Pin folders from their Actions menu.</p>}</Hint>}
    {details && <DriveMetadataDialog item={details} onClose={() => setDetails(null)} />}
  </section>;
}
