"use client";

import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useFormStatus } from "react-dom";
import { usePathname, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownWideNarrow,
  ArrowUp,
  CalendarRange,
  ChevronRight,
  ClipboardPaste,
  Clock3,
  Cloud,
  CloudUpload,
  Download,
  Files,
  Folder,
  FolderInput,
  FolderPlus,
  FolderUp,
  HardDrive,
  LayoutGrid,
  Link2,
  List,
  LockKeyhole,
  LogOut,
  Menu,
  PanelLeft,
  RotateCcw,
  Search,
  Star,
  Tag,
  Trash2,
  TriangleAlert,
  X,
  History,
} from "lucide-react";
import { toast } from "sonner";
import { logout } from "@/app/actions/auth";
import {
  copyItems,
  moveItems,
  restoreItems,
} from "@/app/actions/drive";
import { lockFolder } from "@/app/actions/folder-security";
import { setSearchExcluded } from "@/app/actions/search";
import { SearchAvailabilityProvider, useSearchAvailability, type SearchAvailability } from "@/components/search-availability";
import { CONTENT_SEARCH_MIN_CHARS, FoundInsideFiles } from "@/components/content-search";
import { recordOpened, setFavorites } from "@/app/actions/drive-metadata";
import { listDrive, currentDriveAccessGeneration, assertDriveAccessGeneration, cancelDriveReads } from "@/lib/drive-read-client";
import type {
  DriveFilter,
  DriveItem,
  DriveListInput,
  DriveSort,
  DriveTypeFilter,
} from "@/lib/drive-types";
import { invalidateDriveMetadata, optimisticDriveChange } from "@/lib/drive-cache";
import {
  canEditItem,
  canManageItem,
  permissionLabel,
} from "@/lib/drive-permissions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Filters,
  FilterChips,
  FilterAddButton,
  type FilterField,
  type FilterValue,
} from "@/components/ui/cubby-ui/filters/filters";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/cubby-ui/context-menu";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ThemeToggle } from "@/components/theme-toggle";
import { SoundToggle } from "@/components/ui/sound";
import { Spinner } from "@/components/spinner";
import {
  canPerformItemAction,
  DriveFileIcon,
  DriveItems,
} from "@/components/drive-item";
import {
  beginMarquee,
  DriveDndProvider,
  DroppableCrumb,
  type DropTarget,
} from "@/components/drive-drag";
import type { DriveItemAction } from "@/components/drive-item";
import { McpConnectionDialog } from "@/components/mcp-connection-dialog";
import {
  DriveNameDialog,
  DrivePreviewDialog,
  DriveShareDialog,
  useDriveDownload,
} from "@/components/drive-dialogs";
import {
  DriveMoveDialog,
  DrivePasswordDialog,
  DriveTrashDialog,
} from "@/components/drive-management-dialogs";
import {
  DriveAccessError,
  FolderAccessProvider,
  useFolderAccess,
} from "@/components/folder-access";
import { NameConflictProvider } from "@/components/name-conflicts";
import {
  DriveUndoProvider,
  useConflictRun,
  useDriveUndo,
} from "@/components/drive-undo";
import { useArchiveDownload } from "@/components/drive-archive";
import { DriveUploadQueue, useDriveUploads } from "@/components/drive-uploads";
import { DriveCommandMenu } from "@/components/drive-command-menu";
import { openCommandMenu } from "@/components/ui/command-menu";
import { DriveMetadataDialog } from "@/components/drive-metadata-ui";
import { DriveVersionsDialog } from "@/components/drive-versions-dialog";
import {
  DriveActivityView,
  type ActivityTarget,
} from "@/components/drive-activity";
import { EmptyTrashDialog } from "@/components/drive-empty-trash";
import { AgentConnectButton, StorageCard } from "@/components/sidebar-status";
import { StorageUsageDialog } from "@/components/storage-usage-dialog";
import { ScanFileDialog } from "@/components/file-scan-badge";
import { Hint, TruncatedText } from "@/components/hint";
import {
  PinnedFoldersNav,
  PinnedFoldersProvider,
  usePinnedFolders,
} from "@/components/pinned-folders";
import { Kbd } from "@/components/ui/cubby-ui/kbd";
import { profileAvatarUrl } from "@/lib/profile-avatar";

type FamilyUser = { name: string; email: string };
/** A sidebar destination: a listing filter, or the Activity view. */
type DriveView = DriveFilter | "activity";
type OpenDialog =
  | { kind: "folder"; parentId: string | null }
  | {
      kind:
        | "rename"
        | "share"
        | "preview"
        | "password"
        | "details"
        | "versions"
        | "scan";
      item: DriveItem;
    }
  | { kind: "move" | "trash" | "permanent"; items: DriveItem[] }
  | null;
type FilterValueMap = {
  type: DriveTypeFilter;
  tags: string[];
  modified: { after: string; before: string };
  size: { min: number | null; max: number | null };
};
const typeOptions: { value: Exclude<DriveTypeFilter, "all">; label: string }[] =
  [
    { value: "folder", label: "Folders" },
    { value: "image", label: "Images" },
    { value: "video", label: "Videos" },
    { value: "audio", label: "Audio" },
    { value: "pdf", label: "PDFs" },
    { value: "text", label: "Text" },
    { value: "code", label: "Code" },
    { value: "archive", label: "Archives" },
    { value: "other", label: "Other files" },
  ];
function ModifiedFilterValue({
  value,
  onValueChange,
}: {
  value: FilterValueMap["modified"];
  onValueChange: (value: FilterValueMap["modified"]) => void;
}) {
  const label =
    value.after || value.before
      ? `${value.after || "Any"} – ${value.before || "Any"}`
      : "Choose dates";
  return (
    <Popover defaultOpen>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 max-w-32 rounded-none px-2"
          />
        }
        aria-label="Choose modified date range"
      >
        <span className="truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-w-[calc(100vw-2rem)]">
        <PopoverTitle>Modified date</PopoverTitle>
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel>
              From
              <Input
                type="date"
                aria-label="Modified after"
                max={value.before || undefined}
                value={value.after}
                onChange={(event) =>
                  onValueChange({ ...value, after: event.target.value })
                }
              />
            </FieldLabel>
          </Field>
          <Field>
            <FieldLabel>
              Through
              <Input
                type="date"
                aria-label="Modified before"
                min={value.after || undefined}
                value={value.before}
                onChange={(event) =>
                  onValueChange({ ...value, before: event.target.value })
                }
              />
            </FieldLabel>
          </Field>
        </FieldGroup>
      </PopoverContent>
    </Popover>
  );
}
const filterFields: FilterField[] = [
  {
    id: "type",
    label: "Type",
    icon: <Files />,
    type: "select",
    operators: [{ id: "is", label: "is" }],
    options: typeOptions,
  },
  {
    id: "tags",
    label: "Tags",
    icon: <Tag />,
    type: "text",
    operators: [{ id: "has", label: "includes" }],
    placeholder: "e.g. invoices, 2026",
  },
  {
    id: "modified",
    label: "Modified",
    icon: <CalendarRange />,
    type: "custom",
    defaultValue: { after: "", before: "" },
    renderValue: ({ value, onValueChange }) => {
      const modified = (value ?? {
        after: "",
        before: "",
      }) as FilterValueMap["modified"];
      return (
        <ModifiedFilterValue value={modified} onValueChange={onValueChange} />
      );
    },
  },
  {
    id: "size",
    label: "Size",
    icon: <HardDrive />,
    type: "number",
    operators: [{ id: "between", label: "between", shape: "range" }],
    suffix: "MB",
  },
];
const sortOptions: { value: DriveSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "updatedAt", label: "Date modified" },
  { value: "size", label: "Size" },
  { value: "type", label: "File type" },
];

const destinations = [
  { filter: "all", label: "All files", icon: Files },
  { filter: "recent", label: "Recent", icon: Clock3 },
  { filter: "favorites", label: "Favorites", icon: Star },
  { filter: "public", label: "Public links", icon: Link2 },
  { filter: "activity", label: "Activity", icon: History },
  { filter: "trash", label: "Trash", icon: Trash2 },
] as const;

function LogoutButton({ uploading }: { uploading: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Hint label={uploading ? "Wait for uploads to finish" : "Sign out"}>
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        disabled={pending || uploading}
        aria-label={
          uploading
            ? "Wait for uploads to finish before signing out"
            : "Sign out"
        }
      >
        {pending ? <Spinner /> : <LogOut />}
      </Button>
    </Hint>
  );
}

function DriveSidebar({
  user,
  filter,
  navigate,
  onOpenStorage,
  uploading,
  collapsed = false,
  folderId,
  onOpenPin,
  opening,
}: {
  user: FamilyUser;
  filter: DriveView;
  navigate: (filter: DriveView, folderId?: string) => void;
  onOpenStorage: () => void;
  uploading: boolean;
  collapsed?: boolean;
  folderId: string | null;
  onOpenPin: (folder: DriveItem) => void;
  opening: boolean;
}) {
  const labelClass = cn(
    "origin-left whitespace-nowrap motion-safe:transition-[opacity,transform] motion-safe:duration-170",
    collapsed &&
      "pointer-events-none w-0 -translate-x-1.5 scale-[.84] opacity-0",
  );
  // Read after hydration so the server's markup (Ctrl) never mismatches a Mac's.
  const mac = useSyncExternalStore(
    () => () => {},
    () => /mac/i.test(navigator.userAgent),
    () => false,
  );
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <button
        onClick={() => navigate("all")}
        aria-label="Orole Drive, all files"
        className={cn(
          "flex h-12 shrink-0 items-center gap-2.5 overflow-hidden px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          collapsed && "justify-center gap-0",
        )}
      >
        <Cloud className="size-5 shrink-0 text-primary" strokeWidth={1.7} />
        <span className={cn("text-[13px] font-medium", labelClass)}>
          Orole Drive
        </span>
      </button>
      <div
        className={cn("mt-2 shrink-0 px-3", collapsed && "flex justify-center")}
      >
        {collapsed ? (
          <Hint label="Search (Ctrl or ⌘ K)" side="right">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Search files and commands"
              onClick={() => openCommandMenu()}
            >
              <Search />
            </Button>
          </Hint>
        ) : (
          <button
            type="button"
            onClick={() => openCommandMenu()}
            aria-label="Search files and commands"
            aria-keyshortcuts="Control+K Meta+K"
            className="flex h-8 w-full items-center gap-2 rounded-lg border border-input bg-transparent pl-2.5 pr-1.5 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/65 hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            <Search className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Search files…</span>
            <Kbd size="sm" aria-hidden="true">
              {mac ? "⌘K" : "Ctrl K"}
            </Kbd>
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
        <div
          className={cn(
            "mt-6 overflow-hidden px-5 text-xs text-muted-foreground",
            labelClass,
          )}
          aria-hidden={collapsed}
        >
          Private workspace
        </div>
        <nav
          aria-label="Drive navigation"
          className="mt-2 flex flex-col gap-0.5 px-3"
        >
          {destinations.map(({ filter: value, label, icon: Icon }) => (
            <Hint key={value} label={collapsed ? label : null} side="right">
              <button
                onClick={() => navigate(value)}
                aria-current={filter === value ? "page" : undefined}
                aria-label={label}
                className={cn(
                  "flex min-h-9 items-center gap-2.5 overflow-hidden rounded-lg px-2.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors pointer-coarse:min-h-11",
                  collapsed && "justify-center gap-0 px-0",
                  filter === value
                    ? "bg-sidebar-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/65 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" strokeWidth={1.6} />
                <span className={labelClass} aria-hidden={collapsed}>
                  {label}
                </span>
              </button>
            </Hint>
          ))}
          <PinnedFoldersNav
            collapsed={collapsed}
            folderId={filter === "all" ? folderId : null}
            onOpen={onOpenPin}
            disabled={opening}
          />
        </nav>
      </div>
      <div className="flex shrink-0 flex-col gap-3">
        <div>
          <Separator />
          <StorageCard collapsed={collapsed} onOpen={onOpenStorage} />
          <Separator />
        </div>
        <div
          className={cn(
            "flex items-center gap-2 px-3 pb-3",
            collapsed && "flex-col",
          )}
        >
          <span
            className="flex size-8 shrink-0 overflow-hidden rounded-full bg-sidebar-accent"
            aria-hidden="true"
          >
            {/* DiceBear generates this data URI client-side; Next image optimization cannot process it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={profileAvatarUrl(user)}
              alt=""
              className="size-full"
            />
          </span>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">
                {user.name || user.email.split("@")[0]}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {user.email}
              </p>
            </div>
          )}
          <form action={logout}>
            <LogoutButton uploading={uploading} />
          </form>
        </div>
      </div>
    </div>
  );
}

export function DriveWorkspace({ user, search }: { user: FamilyUser; search: SearchAvailability }) {
  const client = useQueryClient();
  useEffect(() => () => {
    // The root provider survives login navigation; private results must not survive this session's workspace.
    cancelDriveReads();
    client.clear();
  }, [client]);
  return (
    <SearchAvailabilityProvider value={search}>
      <FolderAccessProvider>
        <PinnedFoldersProvider>
          <NameConflictProvider>
            <DriveUndoProvider>
              <DriveWorkspaceContent user={user} />
            </DriveUndoProvider>
          </NameConflictProvider>
        </PinnedFoldersProvider>
      </FolderAccessProvider>
    </SearchAvailabilityProvider>
  );
}

function DriveWorkspaceContent({ user }: { user: FamilyUser }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const client = useQueryClient();
  const { run } = useFolderAccess();
  const pins = usePinnedFolders();
  const folderId = params.get("folder") || null;
  const requestedFilter = params.get("view");
  const filter: DriveFilter =
    requestedFilter === "public" ||
    requestedFilter === "recent" ||
    requestedFilter === "trash" ||
    requestedFilter === "favorites"
      ? requestedFilter
      : "all";
  const trash = filter === "trash";
  // Activity is its own view, not a listing filter: nothing is listed, selected or uploaded there.
  const activity = requestedFilter === "activity";
  const [search, setSearch] = useState("");
  const { search: searchEnabled } = useSearchAvailability();
  // Content matches follow the name results, so the listing stops filling the page while they show.
  const contentSearch = searchEnabled && filter !== "trash" && search.trim().length >= CONTENT_SEARCH_MIN_CHARS;
  const [filterValues, setFilterValues] = useState<FilterValue[]>([]);
  const [sort, setSort] = useState<DriveSort | "activity">(
    filter === "recent" ? "activity" : "name",
  );
  const [direction, setDirection] = useState<"asc" | "desc">(
    filter === "recent" ? "desc" : "asc",
  );
  const availableSorts =
    filter === "recent"
      ? [
          { value: "activity" as const, label: "Last opened/uploaded" },
          ...sortOptions,
        ]
      : sortOptions;
  const deferredSearch = useDeferredValue(search.trim());
  const deferredFilterValues = useDeferredValue(filterValues);
  const [view, setView] = useState<"grid" | "list">("list");
  const [mobileNav, setMobileNav] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const openStorage = () => {
    setMobileNav(false);
    setStorageOpen(true);
  };
  const [collapsed, setCollapsed] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [dragging, setDragging] = useState(false);
  const [opening, setOpening] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);
  const rangeAnchor = useRef<string | null>(null);
  const uploads = useDriveUploads();
  const { addDrop, addFiles } = uploads;
  const download = useDriveDownload();
  const archive = useArchiveDownload();
  const deferredTypeFilter = deferredFilterValues.find(
    (entry) => entry.field === "type",
  );
  const deferredTagsFilter = deferredFilterValues.find(
    (entry) => entry.field === "tags",
  );
  const deferredModifiedFilter = deferredFilterValues.find(
    (entry) => entry.field === "modified",
  );
  const deferredSizeFilter = deferredFilterValues.find(
    (entry) => entry.field === "size",
  );
  const deferredModified = (deferredModifiedFilter?.value ?? {
    after: "",
    before: "",
  }) as FilterValueMap["modified"];
  const deferredSize = (deferredSizeFilter?.value ?? {
    min: null,
    max: null,
  }) as FilterValueMap["size"];
  const deferredTags =
    typeof deferredTagsFilter?.value === "string"
      ? deferredTagsFilter.value
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [];
  const input: DriveListInput = {
    folderId,
    filter,
    search: deferredSearch,
    type: (typeof deferredTypeFilter?.value === "string"
      ? deferredTypeFilter.value
      : "all") as DriveListInput["type"],
    minSize:
      deferredSize.min === null
        ? undefined
        : Math.round(deferredSize.min * 1024 * 1024),
    maxSize:
      deferredSize.max === null
        ? undefined
        : Math.round(deferredSize.max * 1024 * 1024),
    after: deferredModified.after || undefined,
    before: deferredModified.before || undefined,
    tags: deferredTags.length ? deferredTags : undefined,
    sort: sort === "activity" ? undefined : sort,
    direction,
  };
  const queryKey = ["drive", input];
  const scope = JSON.stringify(input);
  const [selection, setSelection] = useState<{
    scope: string;
    ids: Set<string>;
  }>({ scope: "", ids: new Set() });
  const selected =
    selection.scope === scope ? selection.ids : new Set<string>();
  if (selection.scope !== scope && selection.ids.size > 0)
    setSelection({ scope, ids: new Set() });
  const listing = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const result = await listDrive(input, signal);
      if (!result.success)
        throw new DriveAccessError(result.error, result.lockedFolder);
      return result.data;
    },
    placeholderData: (previous, previousQuery) => {
      const previousInput = previousQuery?.queryKey[1] as
        | DriveListInput
        | undefined;
      return previousInput?.folderId === folderId &&
        previousInput?.filter === filter
        ? previous
        : undefined;
    },
    retry: false,
    enabled: !activity && deferredSearch === search.trim() && deferredFilterValues === filterValues,
    staleTime: 15_000,
  });
  const data = activity ? undefined : listing.data;
  const items = data?.items ?? [];
  const selectedItems = items.filter((item) => selected.has(item.id));
  const selectionWritable =
    selectedItems.length > 0 && selectedItems.every(canEditItem);
  const breadcrumbs = data?.breadcrumbs ?? [];
  const currentFolder = data?.currentFolder;
  const attributesActive = Boolean(
    input.type !== "all" ||
    input.tags?.length ||
    input.after ||
    input.before ||
    input.minSize !== undefined ||
    input.maxSize !== undefined,
  );
  const globalSearch = Boolean(search.trim()) || attributesActive;
  const locked =
    listing.error instanceof DriveAccessError
      ? listing.error.lockedFolder
      : undefined;
  const title = activity
    ? "Activity"
    : globalSearch
      ? trash
        ? "Search Trash"
        : "Search results"
      : (currentFolder?.name ??
        (trash
          ? "Trash"
          : filter === "public"
            ? "Public links"
            : filter === "recent"
              ? "Recent"
              : filter === "favorites"
                ? "Favorites"
                : "All files"));
  const destination = currentFolder?.name ?? "All files";
  const canUpload =
    !trash &&
    !activity &&
    !locked &&
    !listing.error &&
    !listing.isPending &&
    !listing.isPlaceholderData &&
    (!folderId || canEditItem(currentFolder));
  const [emptyingTrash, setEmptyingTrash] = useState(false);

  function clearSelection() {
    setSelection({ scope, ids: new Set() });
    rangeAnchor.current = null;
  }
  function selectOnly(id: string) {
    setSelection({ scope, ids: new Set([id]) });
    rangeAnchor.current = id;
  }
  function completeMutation() {
    setDialog(null);
    clearSelection();
  }
  const restore = useMutation({
    mutationFn: (ids: string[]) => run(() => restoreItems(ids)),
    onMutate: async (ids) => ({
      rollback: await optimisticDriveChange(client, { kind: "restore", ids }),
    }),
    onError: (error, _ids, context) => {
      context?.rollback();
      toast.error(error.message);
    },
    onSuccess: (result) => {
      toast.success(
        result.restoredToRoot
          ? `Restored. ${result.restoredToRoot} ${result.restoredToRoot === 1 ? "item was" : "items were"} placed in All files because the original folder is unavailable.`
          : "Restored to original location",
      );
      clearSelection();
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["drive"] });
      void client.invalidateQueries({ queryKey: ["storage-usage"] });
    },
  });
  const [clipboard, setClipboard] = useState<{
    mode: "copy" | "cut";
    items: DriveItem[];
  } | null>(null);
  const conflictRun = useConflictRun();
  const { offerUndo } = useDriveUndo();
  const copy = useMutation({
    mutationFn: ({ ids, target }: { ids: string[]; target: DropTarget }) =>
      conflictRun(
        (resolutions) => copyItems({ ids, parentId: target.id, resolutions }),
        { operation: "copy", destinationName: target.name },
      ),
    onMutate: ({ ids, target }) => ({
      toastId: toast.loading(
        `Copying ${ids.length === 1 ? "1 item" : `${ids.length} items`} to ${target.name}…`,
      ),
    }),
    onError: (error, _variables, context) =>
      toast.error(error.message, { id: context?.toastId }),
    onSuccess: (result, { target }, context) => {
      if (result?.copied)
        offerUndo(
          `${result.copied === 1 ? "Item" : `${result.copied} items`} copied to ${target.name}`,
          { kind: "copy", result },
          { id: context?.toastId },
        );
      else toast("Nothing was copied", { id: context?.toastId });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["drive"] });
      void client.invalidateQueries({ queryKey: ["storage-usage"] });
    },
  });
  const moveDrop = useMutation({
    mutationFn: ({
      ids,
      target,
    }: {
      ids: string[];
      target: DropTarget;
      cut?: NonNullable<typeof clipboard>;
    }) =>
      conflictRun(
        (resolutions) => moveItems({ ids, parentId: target.id, resolutions }),
        {
          operation: "move",
          destinationName: target.name,
          optimistic: () =>
            optimisticDriveChange(client, {
              kind: "move",
              ids,
              parentId: target.id,
            }),
        },
      ),
    onError: (error) => toast.error(error.message),
    onSuccess: (result, { target, cut }) => {
      // Cancelling the name conflict prompt keeps a cut clipboard so pasting can be tried again.
      if (result && cut)
        setClipboard((current) => (current === cut ? null : current));
      if (result?.moved.length)
        offerUndo(
          `${result.moved.length === 1 ? "Item" : `${result.moved.length} items`} moved to ${target.name}`,
          { kind: "move", result },
        );
      else toast("Nothing was moved");
      if (result) clearSelection();
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["drive"] });
      void client.invalidateQueries({ queryKey: ["storage-usage"] });
    },
  });
  const [marquee, setMarquee] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const moveTo = (
    ids: string[],
    target: DropTarget,
    cut?: NonNullable<typeof clipboard>,
  ) => {
    const sources = (cut?.items ?? items).filter((item) =>
      ids.includes(item.id),
    );
    const destinationItem = target.id
      ? (items.find((item) => item.id === target.id) ??
        breadcrumbs.find((crumb) => crumb.id === target.id))
      : null;
    if (
      !actionsDisabled &&
      sources.length === ids.length &&
      sources.every(canEditItem) &&
      (!target.id || canEditItem(destinationItem))
    )
      moveDrop.mutate({ ids, target, cut });
  };
  const dragPreview = (ids: string[]) => {
    const first = items.find((item) => item.id === ids[0]);
    return (
      <div className="flex w-max max-w-64 cursor-grabbing items-center gap-2 rounded-lg border border-border/70 bg-popover py-1.5 pl-1.5 pr-3 text-sm text-popover-foreground shadow-lg">
        {first && <DriveFileIcon item={first} />}
        <span className="truncate font-medium">
          {ids.length > 1 ? `${ids.length} items` : first?.name}
        </span>
      </div>
    );
  };
  const lock = useMutation({
    mutationFn: (id: string) => run(() => lockFolder(id)),
    onSuccess: () => {
      window.dispatchEvent(new Event("drive-access-changed"));
      toast.success("Folder locked");
    },
    onError: (error) => toast.error(error.message),
  });
  const searchExclusion = useMutation({
    mutationFn: (input: { id: string; excluded: boolean }) =>
      run(() => setSearchExcluded(input)),
    onSuccess: (_result, { excluded }) => {
      // Passages from the folder may sit in cached results; they are already gone from the index.
      client.removeQueries({ queryKey: ["semantic-search"] });
      toast.success(
        excluded
          ? "Excluded from AI search"
          : "Included in AI search. Files are indexed in the background.",
      );
    },
    onError: (error) => toast.error(error.message),
    onSettled: (_result, _error, { id }) => {
      invalidateDriveMetadata(client, [id]);
      void client.invalidateQueries({ queryKey: ["search-status"] });
    },
  });
  const favorite = useMutation({
    mutationFn: ({ ids, favorited }: { ids: string[]; favorited: boolean }) =>
      run(() => setFavorites(ids, favorited)),
    onMutate: async ({ ids, favorited }) => ({
      rollback: await optimisticDriveChange(client, {
        kind: "favorite",
        ids,
        favorited,
      }),
    }),
    onError: (error, _variables, context) => {
      context?.rollback();
      toast.error(error.message);
    },
    onSuccess: (_result, { ids, favorited }) =>
      toast.success(
        ids.length === 1
          ? favorited
            ? "Added to favorites"
            : "Removed from favorites"
          : `${ids.length} items ${favorited ? "added to" : "removed from"} favorites`,
      ),
    onSettled: (_result, _error, { ids }) => {
      invalidateDriveMetadata(client, ids);
    },
  });
  const stale =
    listing.isPlaceholderData ||
    deferredSearch !== search.trim() ||
    deferredFilterValues !== filterValues;
  const actionsDisabled =
    stale ||
    opening ||
    restore.isPending ||
    lock.isPending ||
    moveDrop.isPending ||
    copy.isPending;
  // Pasting goes into the folder being viewed; not into Trash, search results or the Recent/Favorites/Public views.
  const pasteTarget: DropTarget | null =
    !clipboard || !canUpload || globalSearch || filter !== "all"
      ? null
      : { id: folderId ?? null, name: currentFolder?.name ?? "All files" };
  function toClipboard(mode: "copy" | "cut", targets: DriveItem[]) {
    if (!targets.length || trash || actionsDisabled) return;
    if (mode === "cut" && !targets.every(canEditItem)) {
      toast.error("Viewer access cannot cut items. Use Copy instead.");
      return;
    }
    setClipboard({ mode, items: targets });
    toast(
      `${targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} items`} ${mode === "cut" ? "cut" : "copied"}`,
      { description: "Open a folder and press Ctrl+V to paste." },
    );
  }
  function paste() {
    if (!clipboard || !pasteTarget || actionsDisabled) return;
    const ids = clipboard.items.map((item) => item.id);
    if (clipboard.mode === "copy")
      return copy.mutate({ ids, target: pasteTarget });
    // Cutting into the folder the items are already in does nothing, like Explorer.
    const moving = clipboard.items
      .filter((item) => item.parentId !== pasteTarget.id)
      .map((item) => item.id);
    if (moving.length) moveTo(moving, pasteTarget, clipboard);
    else setClipboard(null);
  }

  function navigate(nextFilter: DriveView, nextFolder?: string) {
    if (nextFilter !== filter) {
      setSort(nextFilter === "recent" ? "activity" : "name");
      setDirection(nextFilter === "recent" ? "desc" : "asc");
    }
    const next = new URLSearchParams();
    if (nextFilter !== "all") next.set("view", nextFilter);
    if (nextFolder) next.set("folder", nextFolder);
    setSearch("");
    setFilterValues([]);
    setMobileNav(false);
    clearSelection();
    window.history.pushState(
      null,
      "",
      `${pathname}${next.size ? `?${next}` : ""}`,
    );
  }
  function folderInput(id: string, fromTrash: boolean): DriveListInput {
    const nextFilter = fromTrash ? "trash" : "all";
    // Match navigate's sort reset, and the subsequent useQuery key, exactly.
    return {
      folderId: id,
      filter: nextFilter,
      search: "",
      type: "all",
      sort: nextFilter !== filter ? "name" : sort === "activity" ? undefined : sort,
      direction: nextFilter !== filter ? "asc" : direction,
    };
  }
  async function openItem(item: DriveItem, fromTrash = trash) {
    if (actionsDisabled) return;
    if (item.kind === "file") {
      if (!fromTrash) {
        setDialog({ kind: "preview", item });
        void recordOpened(item.id);
      }
      return;
    }
    const nextInput = folderInput(item.id, fromTrash);
    const generation = currentDriveAccessGeneration();
    setOpening(true);
    try {
      await run(async () => {
        try {
          const data = await client.fetchQuery({
            queryKey: ["drive", nextInput],
            queryFn: async ({ signal }) => {
              const result = await listDrive(nextInput, signal);
              if (!result.success) throw new DriveAccessError(result.error, result.lockedFolder);
              return result.data;
            },
            staleTime: 15_000,
            retry: false,
          });
          return { success: true, data };
        } catch (error) {
          // An in-flight hover prefetch can discover a locked ancestor. Prompt only on open.
          if (error instanceof DriveAccessError) return { success: false, error: error.message, lockedFolder: error.lockedFolder };
          throw error;
        }
      });
      assertDriveAccessGeneration(generation);
      navigate(fromTrash ? "trash" : "all", item.id);
      if (!fromTrash) void recordOpened(item.id);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not open folder.",
      );
    } finally {
      setOpening(false);
    }
  }
  function openActivityTarget(target: ActivityTarget) {
    if ("item" in target) void openItem(target.item);
    else navigate(target.trash ? "trash" : "all", target.folderId ?? undefined);
  }
  function prefetchFolder(item: DriveItem) {
    if (item.kind !== "folder" || item.isLocked || trash || actionsDisabled)
      return;
    const nextInput = folderInput(item.id, false);
    void client.prefetchQuery({
      queryKey: ["drive", nextInput],
      queryFn: async ({ signal }) => {
        const result = await listDrive(nextInput, signal);
        if (!result.success)
          throw new DriveAccessError(result.error, result.lockedFolder);
        return result.data;
      },
      staleTime: 15_000,
    });
  }
  function selectItem(id: string, range: boolean) {
    if (actionsDisabled) return;
    const ids = new Set(selected);
    const start = items.findIndex((item) => item.id === rangeAnchor.current);
    const end = items.findIndex((item) => item.id === id);
    if (range && start >= 0 && end >= 0) {
      for (
        let index = Math.min(start, end);
        index <= Math.max(start, end);
        index++
      )
        ids.add(items[index].id);
    } else {
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      rangeAnchor.current = id;
    }
    setSelection({ scope, ids });
  }
  function uploadFiles(parentId: string | null) {
    uploadTarget.current = parentId;
    fileInput.current?.click();
  }
  function onItemAction(action: DriveItemAction, targets: DriveItem[]) {
    if (actionsDisabled || !canPerformItemAction(action, targets)) return;
    const item = targets[0];
    if (action === "open") void openItem(item);
    else if (action === "download") {
      if (targets.length === 1 && item.kind === "file")
        download.mutate(item.id);
      else archive.start(targets.map((target) => target.id));
    } else if (action === "restore")
      restore.mutate(targets.map((target) => target.id));
    else if (action === "lock") lock.mutate(item.id);
    else if (action === "search-exclude")
      searchExclusion.mutate({ id: item.id, excluded: !item.searchExcluded });
    else if (action === "favorite" || action === "unfavorite")
      favorite.mutate({
        ids: targets.map((target) => target.id),
        favorited: action === "favorite",
      });
    else if (action === "pin" || action === "unpin") {
      if (targets.length === 1 && item.kind === "folder")
        pins.mutation.mutate({ id: item.id, pinned: action === "pin" });
    } else if (
      action === "move" ||
      action === "trash" ||
      action === "permanent"
    )
      setDialog({ kind: action, items: targets });
    else if (action === "upload-files") uploadFiles(item.id);
    else if (action === "upload-folder") uploads.chooseFolder(item.id);
    else if (action === "new-folder")
      setDialog({ kind: "folder", parentId: item.id });
    else if (action === "cut" || action === "copy")
      toClipboard(action, targets);
    else setDialog({ kind: action, item });
  }
  async function unlockCurrent() {
    setOpening(true);
    try {
      const generation = currentDriveAccessGeneration();
      const data = await run(() => listDrive(input));
      assertDriveAccessGeneration(generation);
      client.setQueryData(queryKey, data);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not unlock folder.",
      );
    } finally {
      setOpening(false);
    }
  }

  useEffect(() => {
    function accessChanged(event: Event) {
      const keepSharingId = (event as CustomEvent<{ keepSharingId?: string }>).detail?.keepSharingId;
      setDialog((current) => current?.kind === "share" && current.item.id === keepSharingId ? current : null);
      setSelection({ scope: "", ids: new Set() });
      setClipboard(null);
      // Reset observed queries as well as cached prefetched data; do not retain revoked names or URLs.
      void client.resetQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          if (key === "drive-sharing" && query.queryKey[1] === keepSharingId) return false;
          return typeof key === "string" && (
            key === "drive" || key.startsWith("drive-") || key === "command-recent" ||
            key === "storage-usage" || key === "private-file-scan" ||
            key === "text-preview" || key === "text-highlight" ||
            key === "semantic-search" || key === "search-status"
          );
        },
      });
    }
    window.addEventListener("drive-access-changed", accessChanged);
    return () =>
      window.removeEventListener("drive-access-changed", accessChanged);
  }, [client]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("[role=dialog], [role=alertdialog]")) return;
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !target?.closest(
          "input, textarea, select, [contenteditable=true], [role=menu]",
        )
      ) {
        event.preventDefault();
        document.getElementById("drive-global-search")?.focus();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    let depth = 0;
    function enter(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      depth++;
      if (canUpload) setDragging(true);
    }
    function over(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = canUpload ? "copy" : "none";
    }
    function leave(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    }
    function reset() {
      depth = 0;
      setDragging(false);
    }
    function drop(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      reset();
      if (canUpload) addDrop(event.dataTransfer, folderId);
      else
        toast.error(
          "Open All files or an unlocked folder where you are an editor to upload.",
        );
    }
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("blur", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("blur", reset);
      window.removeEventListener("dragend", reset);
    };
  }, [folderId, canUpload, trash, activity, addDrop]);
  useEffect(() => {
    function paste(event: ClipboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable=true], [role=dialog], [role=alertdialog]",
        )
      )
        return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      if (canUpload) addFiles(files, folderId);
      else
        toast.error(
          "Open All files or an unlocked folder where you are an editor to paste files.",
        );
    }
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [canUpload, folderId, trash, activity, addFiles]);

  const uploadActions = (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={!canUpload}
        onClick={() => uploadFiles(folderId)}
      >
        <ArrowUp data-icon="inline-start" />
        Upload files
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!canUpload}
        onClick={() => uploads.chooseFolder(folderId)}
      >
        <FolderUp data-icon="inline-start" />
        Upload folder
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!canUpload}
        onClick={() => setDialog({ kind: "folder", parentId: folderId })}
      >
        <FolderPlus data-icon="inline-start" />
        New folder
      </Button>
    </>
  );
  return (
    <div className="flex min-h-dvh bg-background">
      <a
        href="#drive-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-3 focus:ring-2 focus:ring-ring"
      >
        Skip to files
      </a>
      <aside
        id="drive-sidebar"
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 border-r border-sidebar-border bg-sidebar md:block motion-safe:transition-[width] motion-safe:duration-[240ms] motion-safe:ease-[cubic-bezier(.5,0,.1,1)]",
          collapsed ? "w-[72px]" : "w-[230px]",
        )}
      >
        <DriveSidebar
          user={user}
          filter={activity ? "activity" : filter}
          navigate={navigate}
          onOpenStorage={openStorage}
          uploading={uploads.pending > 0}
          collapsed={collapsed}
          folderId={folderId}
          onOpenPin={(item) => void openItem(item, false)}
          opening={actionsDisabled}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/65 bg-background/95 px-3 backdrop-blur-sm sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              className="md:hidden"
              variant="ghost"
              size="icon"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu />
            </Button>
            <Button
              className="hidden md:inline-flex"
              variant="ghost"
              size="icon"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              aria-controls="drive-sidebar"
              onClick={() => setCollapsed(!collapsed)}
            >
              <PanelLeft />
            </Button>
            <span className="truncate text-[13px] font-medium">
              Private workspace
            </span>
          </div>
          <div className="flex items-center gap-2">
            <AgentConnectButton onConnect={() => setMcpOpen(true)} />
            <SoundToggle className="size-8 rounded-lg" />
            <ThemeToggle />
          </div>
        </header>
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <main
                id="drive-content"
                tabIndex={-1}
                className="flex flex-1 flex-col px-4 pb-16 pt-7 outline-none sm:px-7 lg:px-9"
              />
            }
            onKeyDown={(event) => {
              if (event.defaultPrevented) return;
              const target = event.target as HTMLElement;
              if (
                target.closest(
                  "input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]",
                )
              )
                return;
              const shortcutKey =
                (event.ctrlKey || event.metaKey) &&
                !event.altKey &&
                !event.shiftKey
                  ? event.key.toLowerCase()
                  : null;
              // Leave Ctrl+C alone when the user has text selected, so copying text still works.
              const textSelected = Boolean(window.getSelection()?.toString());
              if (shortcutKey === "a" && !actionsDisabled) {
                event.preventDefault();
                setSelection({
                  scope,
                  ids: new Set(items.map((item) => item.id)),
                });
              } else if (
                (shortcutKey === "c" || shortcutKey === "x") &&
                !textSelected &&
                !trash
              ) {
                const focusedId =
                  target.closest<HTMLElement>("[data-drive-item]")?.dataset
                    .driveItem;
                const targets = selectedItems.length
                  ? selectedItems
                  : items.filter((item) => item.id === focusedId);
                if (!targets.length) return;
                event.preventDefault();
                toClipboard(shortcutKey === "x" ? "cut" : "copy", targets);
              } else if (shortcutKey === "v" && clipboard) {
                event.preventDefault();
                if (pasteTarget) paste();
                else
                  toast.error("Open All files or a writable folder to paste.");
              } else if (event.key === "Escape") {
                clearSelection();
                if (clipboard?.mode === "cut") setClipboard(null);
              } else if (
                !actionsDisabled &&
                (event.key === "F2" ||
                  event.key === "Delete" ||
                  event.key === " ")
              ) {
                const focusedId =
                  target.closest<HTMLElement>("[data-drive-item]")?.dataset
                    .driveItem;
                const focusedItem = items.find((item) => item.id === focusedId);
                const targets = selectedItems.length
                  ? selectedItems
                  : focusedItem
                    ? [focusedItem]
                    : [];
                if (!targets.length) return;
                if (event.key === "F2" && !trash && targets.length === 1) {
                  event.preventDefault();
                  onItemAction("rename", targets);
                } else if (event.key === "Delete") {
                  event.preventDefault();
                  onItemAction(trash ? "permanent" : "trash", targets);
                } else if (
                  event.key === " " &&
                  !trash &&
                  targets.length === 1 &&
                  targets[0].kind === "file" &&
                  !target.closest("[role=checkbox], [aria-haspopup]")
                ) {
                  event.preventDefault();
                  void openItem(targets[0]);
                }
              }
            }}
          >
            <DriveDndProvider
              enabled={!actionsDisabled}
              renderPreview={dragPreview}
              onMove={moveTo}
            >
              <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <TruncatedText
                      as="h1"
                      className="max-w-[80vw] text-xl font-medium tracking-[-0.025em] md:max-w-[50vw]"
                    >
                      {title}
                    </TruncatedText>
                    <p className="mt-1.5 max-w-lg text-xs leading-relaxed text-muted-foreground">
                      {activity
                        ? "Changes to files and folders you can access."
                        : trash
                          ? "Items stay in Trash for 30 days. Restoring does not restore public links."
                          : globalSearch
                            ? "Searching only files and folders you can access."
                            : filter === "public"
                              ? "Accessible files and folders with an explicit public link."
                              : filter === "recent"
                                ? "Your recent files and accessible updates."
                                : filter === "favorites"
                                  ? "Files and folders you’ve starred."
                                  : currentFolder
                                    ? `${permissionLabel[currentFolder.permission]} access. ${canUpload ? "New uploads and folders inherit this folder’s access, including public folder links. Choose Only me in Manage access to make an item private." : "You can view, download and copy. Uploads and changes require Editor access."}`
                                    : "Your private files and items shared with you. New uploads here are only visible to you."}
                    </p>
                  </div>
                  {trash
                    ? !folderId &&
                      !globalSearch && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            !items.some(canEditItem) || listing.isPending
                          }
                          onClick={() => setEmptyingTrash(true)}
                        >
                          <Trash2 data-icon="inline-start" />
                          Empty Trash
                        </Button>
                      )
                    : !activity && (
                        <div className="flex flex-wrap items-center gap-2">
                          {uploadActions}
                        </div>
                      )}
                </div>
                {activity ? (
                  <div className="mt-5 flex flex-1 flex-col">
                    <DriveActivityView onOpen={openActivityTarget} />
                  </div>
                ) : (
                  <>
                    <div className="mb-4 mt-5 flex flex-wrap items-center justify-between gap-3">
                      <nav
                        aria-label="Folder breadcrumbs"
                        className="min-w-0 max-w-full overflow-x-auto"
                      >
                        <ol className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                          <li>
                            <DroppableCrumb
                              target={{ id: null, name: "All files" }}
                              disabled={!folderId || trash || globalSearch}
                              onClick={() => navigate(trash ? "trash" : "all")}
                              className="min-h-8 rounded px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {trash ? "Trash" : "All files"}
                            </DroppableCrumb>
                          </li>
                          {breadcrumbs.map((crumb, index) => (
                            <li
                              key={crumb.id}
                              className="flex items-center gap-1"
                            >
                              <ChevronRight className="size-3 shrink-0" />
                              <DroppableCrumb
                                target={{ id: crumb.id, name: crumb.name }}
                                disabled={
                                  trash ||
                                  globalSearch ||
                                  !canEditItem(crumb) ||
                                  index === breadcrumbs.length - 1
                                }
                                onClick={() =>
                                  navigate(trash ? "trash" : "all", crumb.id)
                                }
                                aria-current={
                                  !globalSearch &&
                                  index === breadcrumbs.length - 1
                                    ? "page"
                                    : undefined
                                }
                                className="min-h-8 max-w-36 truncate rounded px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {crumb.name}
                              </DroppableCrumb>
                            </li>
                          ))}
                          {globalSearch && (
                            <li className="flex items-center gap-1">
                              <ChevronRight className="size-3" />
                              <span aria-current="page">
                                All-folder results
                              </span>
                            </li>
                          )}
                        </ol>
                      </nav>
                      <div className="ml-auto flex shrink-0 items-center gap-2">
                        {currentFolder?.hasPassword && !trash && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={actionsDisabled}
                            aria-label="Lock this folder"
                            onClick={() => lock.mutate(currentFolder.id)}
                          >
                            <LockKeyhole />
                          </Button>
                        )}
                        {data && (
                          <Badge variant="secondary">
                            {items.length}{" "}
                            {items.length === 1 ? "item" : "items"}
                          </Badge>
                        )}
                        <ToggleGroup
                          value={[view]}
                          onValueChange={(value) => {
                            if (value[0] === "grid" || value[0] === "list")
                              setView(value[0]);
                          }}
                          size="sm"
                          spacing={0}
                          aria-label="File view"
                        >
                          <ToggleGroupItem value="list" aria-label="List view">
                            <List />
                          </ToggleGroupItem>
                          <ToggleGroupItem value="grid" aria-label="Grid view">
                            <LayoutGrid />
                          </ToggleGroupItem>
                        </ToggleGroup>
                      </div>
                    </div>
                    <section
                      aria-label="Search and filters"
                      className="mb-5 flex flex-wrap items-center gap-2"
                    >
                      <div className="relative min-w-0 flex-1 sm:max-w-xs">
                        <Search
                          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <Input
                          id="drive-global-search"
                          data-drive-search
                          type="search"
                          aria-label={searchEnabled ? "Search file names and contents" : "Search file names"}
                          value={search}
                          placeholder={searchEnabled ? "Search names and contents…" : "Search file names…"}
                          onChange={(event) => setSearch(event.target.value)}
                          className="pl-8"
                        />
                      </div>
                      <Filters
                        fields={filterFields}
                        value={filterValues}
                        onValueChange={setFilterValues}
                        size="sm"
                        className="max-w-full"
                      >
                        <FilterChips />
                        <FilterAddButton shortcut="f" />
                      </Filters>
                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
                        {(search || filterValues.length > 0) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setSearch("");
                              setFilterValues([]);
                            }}
                          >
                            <X data-icon="inline-start" />
                            Clear
                          </Button>
                        )}
                        <Select
                          value={sort}
                          items={availableSorts}
                          onValueChange={(value) => {
                            if (value) setSort(value);
                          }}
                        >
                          <SelectTrigger
                            size="sm"
                            aria-label="Sort by"
                            className="w-auto"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {availableSorts.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          onClick={() =>
                            setDirection(direction === "asc" ? "desc" : "asc")
                          }
                          aria-label={`Sort ${direction === "asc" ? "descending" : "ascending"}`}
                        >
                          <ArrowDownWideNarrow
                            className={cn(direction === "desc" && "rotate-180")}
                          />
                        </Button>
                      </div>
                    </section>
                    <div
                      aria-live="polite"
                      role="status"
                      className="mb-3 flex min-h-5 items-center gap-2 text-xs text-muted-foreground"
                    >
                      {(listing.isFetching || stale || opening) && (
                        <>
                          <Spinner size={12} />
                          {opening
                            ? "Opening folder…"
                            : data
                              ? "Updating files…"
                              : "Loading files…"}
                        </>
                      )}
                    </div>
                    {data && !listing.error && items.length > 0 && (
                      <div
                        className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-2"
                        aria-label="Selection actions"
                      >
                        <div className="flex min-h-8 items-center gap-3 pr-2">
                          <Checkbox
                            id="drive-select-all"
                            checked={selectedItems.length === items.length}
                            indeterminate={
                              selectedItems.length > 0 &&
                              selectedItems.length < items.length
                            }
                            disabled={actionsDisabled}
                            onCheckedChange={(checked) => {
                              setSelection({
                                scope,
                                ids: checked
                                  ? new Set(items.map((item) => item.id))
                                  : new Set(),
                              });
                            }}
                          />
                          <label
                            htmlFor="drive-select-all"
                            className="cursor-pointer text-xs"
                          >
                            {selectedItems.length
                              ? `${selectedItems.length} selected`
                              : "Select all"}
                          </label>
                        </div>
                        {selectedItems.length > 0 && (
                          <>
                            {trash ? (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    actionsDisabled || !selectionWritable
                                  }
                                  onClick={() =>
                                    onItemAction("restore", selectedItems)
                                  }
                                >
                                  <RotateCcw />
                                  Restore
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    actionsDisabled || !selectionWritable
                                  }
                                  onClick={() =>
                                    onItemAction("permanent", selectedItems)
                                  }
                                >
                                  <Trash2 />
                                  Delete permanently
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    actionsDisabled || archive.isPending
                                  }
                                  onClick={() =>
                                    archive.start(
                                      selectedItems.map((item) => item.id),
                                    )
                                  }
                                >
                                  <Download />
                                  Download ZIP
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    actionsDisabled || !selectionWritable
                                  }
                                  onClick={() =>
                                    onItemAction("move", selectedItems)
                                  }
                                >
                                  <FolderInput />
                                  Move
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    actionsDisabled || !selectionWritable
                                  }
                                  onClick={() =>
                                    onItemAction("trash", selectedItems)
                                  }
                                >
                                  <Trash2 />
                                  Move to Trash
                                </Button>
                              </>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={clearSelection}
                            >
                              Clear selection
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                    <div
                      className={contentSearch ? "flex flex-col" : "flex flex-1 flex-col"}
                      aria-busy={listing.isFetching || stale || opening}
                      onPointerDown={(event) => {
                        if (!actionsDisabled && items.length)
                          beginMarquee(event, {
                            selected,
                            onSelect: (ids) => setSelection({ scope, ids }),
                            onBox: setMarquee,
                          });
                      }}
                    >
                      {marquee && (
                        <div
                          aria-hidden="true"
                          className="pointer-events-none fixed z-50 rounded-sm border border-primary/70 bg-primary/10"
                          style={marquee}
                        />
                      )}
                      {listing.isPending ? (
                        <div
                          aria-label="Loading files"
                          className="flex flex-col gap-5 py-3"
                        >
                          {Array.from({ length: 5 }, (_, index) => (
                            <div
                              key={index}
                              className="flex items-center gap-3"
                            >
                              <Skeleton className="size-10 rounded-xl" />
                              <div className="flex flex-1 flex-col gap-2">
                                <Skeleton className="h-3 w-2/5" />
                                <Skeleton className="h-2 w-1/5" />
                              </div>
                              <Skeleton className="h-3 w-16" />
                            </div>
                          ))}
                        </div>
                      ) : locked ? (
                        <Empty className="mx-auto my-auto max-w-md border-0 px-0 py-12">
                          <EmptyHeader>
                            <EmptyMedia>
                              <LockKeyhole
                                className="size-10 text-muted-foreground"
                                strokeWidth={1.2}
                              />
                            </EmptyMedia>
                            <EmptyTitle>This folder is locked</EmptyTitle>
                            <EmptyDescription>
                              Enter the password for “{locked.name}” to see its
                              files.
                            </EmptyDescription>
                          </EmptyHeader>
                          <EmptyContent>
                            <Button
                              disabled={opening}
                              onClick={() => void unlockCurrent()}
                            >
                              {opening && <Spinner />}Unlock folder
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => navigate(trash ? "trash" : "all")}
                            >
                              Back to {trash ? "Trash" : "All files"}
                            </Button>
                          </EmptyContent>
                        </Empty>
                      ) : listing.error ? (
                        <Alert variant="destructive">
                          <TriangleAlert />
                          <AlertTitle>We couldn’t load your files</AlertTitle>
                          <AlertDescription>
                            <p>{listing.error.message}</p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void listing.refetch()}
                              >
                                Try again
                              </Button>
                              {globalSearch && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setSearch("");
                                    setFilterValues([]);
                                  }}
                                >
                                  Clear filters
                                </Button>
                              )}
                              {folderId && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    navigate(trash ? "trash" : "all")
                                  }
                                >
                                  Back to {trash ? "Trash" : "All files"}
                                </Button>
                              )}
                            </div>
                          </AlertDescription>
                        </Alert>
                      ) : items.length ? (
                        <DriveItems
                          items={items}
                          currentUserEmail={user.email}
                          view={view}
                          selected={selected}
                          trash={trash}
                          disabled={actionsDisabled}
                          onSelect={selectItem}
                          onSelectOnly={selectOnly}
                          cutIds={
                            clipboard?.mode === "cut"
                              ? new Set(clipboard.items.map((item) => item.id))
                              : undefined
                          }
                          onOpen={(item) => void openItem(item)}
                          onOpenIntent={prefetchFolder}
                          onAction={onItemAction}
                          draggable
                        />
                      ) : (
                        <Empty className="mx-auto my-auto w-full max-w-md border-0 px-0 py-12">
                          <EmptyHeader>
                            <EmptyMedia>
                              {globalSearch ? (
                                <Search
                                  className="size-10 text-muted-foreground"
                                  strokeWidth={1.2}
                                />
                              ) : trash ? (
                                <Trash2
                                  className="size-10 text-muted-foreground"
                                  strokeWidth={1.2}
                                />
                              ) : filter === "public" ? (
                                <Link2
                                  className="size-10 text-muted-foreground"
                                  strokeWidth={1.2}
                                />
                              ) : filter === "favorites" ? (
                                <Star
                                  className="size-10 text-muted-foreground"
                                  strokeWidth={1.2}
                                />
                              ) : (
                                <Folder
                                  className="size-12 text-muted-foreground"
                                  strokeWidth={1.1}
                                />
                              )}
                            </EmptyMedia>
                            <EmptyTitle>
                              {globalSearch
                                ? "No matching files"
                                : trash
                                  ? "Nothing to restore"
                                  : filter === "public"
                                    ? "No public links"
                                    : filter === "favorites"
                                      ? "No favorites yet"
                                      : currentFolder
                                        ? "No accessible items here"
                                        : "Make room for your files"}
                            </EmptyTitle>
                            <EmptyDescription>
                              {globalSearch
                                ? "Try a different name, or clear the filters to see more files."
                                : trash
                                  ? "Accessible items moved to Trash appear here for 30 days."
                                  : filter === "public"
                                    ? "Choose Manage access on an item you own to create an intentional public link."
                                    : filter === "favorites"
                                      ? "Star a file or folder from its menu to find it here quickly."
                                      : currentFolder
                                        ? canUpload
                                          ? "Add files or create a folder. New items inherit this folder’s access."
                                          : "You have Viewer access. Ask the owner for Editor access to add files."
                                        : "Upload files or a folder. New items here are private until you share them."}
                            </EmptyDescription>
                          </EmptyHeader>
                          <EmptyContent className="w-full">
                            {globalSearch ? (
                              <Button
                                variant="outline"
                                onClick={() => {
                                  setSearch("");
                                  setFilterValues([]);
                                }}
                              >
                                Clear filters
                              </Button>
                            ) : trash ||
                              filter === "public" ||
                              filter === "favorites" ||
                              !canUpload ? (
                              <Button
                                variant="outline"
                                onClick={() => navigate("all")}
                              >
                                Browse all files
                              </Button>
                            ) : (
                              <>
                                <div className="flex flex-wrap justify-center gap-2">
                                  {uploadActions}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  Or drop files and folders here.
                                </p>
                              </>
                            )}
                          </EmptyContent>
                        </Empty>
                      )}
                    </div>
                    {contentSearch && (
                      <FoundInsideFiles
                        query={search}
                        onOpen={(item) => void openItem(item, false)}
                        onShowFolder={(target) => navigate("all", target ?? undefined)}
                      />
                    )}
                    {canUpload && items.length > 0 && (
                      <p className="mt-auto pt-8 text-center text-xs text-muted-foreground">
                        Drop files or folders to upload to {destination}.
                      </p>
                    )}
                  </>
                )}
              </div>
            </DriveDndProvider>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuGroup>
              <ContextMenuItem
                disabled={!pasteTarget || actionsDisabled}
                onClick={paste}
              >
                <ClipboardPaste />
                {clipboard
                  ? `Paste ${clipboard.items.length === 1 ? "1 item" : `${clipboard.items.length} items`}`
                  : "Paste"}
                <ContextMenuShortcut>Ctrl V</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={!canUpload}
                onClick={() => uploadFiles(folderId)}
              >
                <ArrowUp />
                Upload files
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!canUpload}
                onClick={() => uploads.chooseFolder(folderId)}
              >
                <FolderUp />
                Upload folder
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!canUpload}
                onClick={() =>
                  setDialog({ kind: "folder", parentId: folderId })
                }
              >
                <FolderPlus />
                New folder
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        aria-label="Choose files to upload"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) uploads.addFiles(files, uploadTarget.current);
          event.target.value = "";
        }}
      />
      <Dialog open={mobileNav} onOpenChange={setMobileNav}>
        <DialogContent className="h-[min(680px,90dvh)] min-h-0 sm:max-w-sm">
          <DialogHeader className="sr-only">
            <DialogTitle>Drive navigation</DialogTitle>
            <DialogDescription>
              Browse your files and items shared with you, and manage your
              account.
            </DialogDescription>
          </DialogHeader>
          <DriveSidebar
            user={user}
            filter={activity ? "activity" : filter}
            navigate={navigate}
            onOpenStorage={openStorage}
            uploading={uploads.pending > 0}
            folderId={folderId}
            onOpenPin={(item) => {
              setMobileNav(false);
              void openItem(item, false);
            }}
            opening={actionsDisabled}
          />
        </DialogContent>
      </Dialog>
      <McpConnectionDialog open={mcpOpen} onOpenChange={setMcpOpen} />
      <StorageUsageDialog
        open={storageOpen}
        onOpenChange={setStorageOpen}
        onNavigate={navigate}
      />
      <DriveCommandMenu
        filter={activity ? "activity" : filter}
        items={items}
        selected={selectedItems}
        canUpload={canUpload}
        view={view}
        collapsed={collapsed}
        onEmptyTrash={() => {
          if (trash && items.some(canEditItem)) setEmptyingTrash(true);
        }}
        onNavigate={(target) => navigate(target)}
        onOpenItem={(item) => void openItem(item)}
        onItemAction={onItemAction}
        onUploadFiles={() => uploadFiles(folderId)}
        onUploadFolder={() => uploads.chooseFolder(folderId)}
        onNewFolder={() => setDialog({ kind: "folder", parentId: folderId })}
        onViewChange={setView}
        onToggleSidebar={() => setCollapsed(!collapsed)}
        onConnectAgent={() => setMcpOpen(true)}
        onOpenStorage={openStorage}
        onSearchInside={searchEnabled ? (query) => {
          if (trash || activity) navigate("all");
          setSearch(query);
        } : undefined}
      />
      {dialog?.kind === "folder" && (
        <DriveNameDialog
          parentId={dialog.parentId}
          onClose={completeMutation}
        />
      )}
      {dialog?.kind === "rename" && (
        <DriveNameDialog
          key={dialog.item.id}
          item={dialog.item}
          parentId={folderId}
          onClose={completeMutation}
        />
      )}
      {dialog?.kind === "share" && (
        <DriveShareDialog
          key={dialog.item.id}
          item={dialog.item}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "preview" && (
        <DrivePreviewDialog
          key={dialog.item.id}
          item={dialog.item}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "move" && (
        <DriveMoveDialog
          items={dialog.items}
          onClose={() => setDialog(null)}
          onComplete={completeMutation}
        />
      )}
      {(dialog?.kind === "trash" || dialog?.kind === "permanent") && (
        <DriveTrashDialog
          items={dialog.items}
          permanent={dialog.kind === "permanent"}
          onClose={() => setDialog(null)}
          onComplete={completeMutation}
        />
      )}
      {dialog?.kind === "password" && canManageItem(dialog.item) && (
        <DrivePasswordDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
          onComplete={completeMutation}
        />
      )}
      {dialog?.kind === "scan" && canManageItem(dialog.item) && (
        <ScanFileDialog
          key={dialog.item.id}
          item={dialog.item}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "details" && (
        <DriveMetadataDialog
          key={dialog.item.id}
          item={dialog.item}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "versions" && (
        <DriveVersionsDialog
          key={dialog.item.id}
          item={dialog.item}
          onClose={() => setDialog(null)}
        />
      )}
      {emptyingTrash && (
        <EmptyTrashDialog onClose={() => setEmptyingTrash(false)} />
      )}
      {archive.dialog}
      <DriveUploadQueue uploads={uploads} />
      {dragging && (
        <div
          className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/95"
          role="status"
        >
          <div className="flex flex-col items-center gap-4 px-6 text-center">
            <CloudUpload className="size-12 text-primary" strokeWidth={1.4} />
            <p className="text-xl font-medium tracking-tight">
              Drop files or folders to upload
            </p>
            <p className="text-sm text-muted-foreground">
              Add to {destination}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
