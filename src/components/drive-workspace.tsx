"use client";

import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { usePathname, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownWideNarrow, ArrowUp, CalendarRange, ChevronRight, Clock3, Cloud, CloudUpload, Download,
  Files, Folder, FolderInput, FolderPlus, FolderUp, HardDrive, LayoutGrid, Link2,
  List, LockKeyhole, LogOut, Menu, PanelLeft, Plug, RotateCcw, Search, ShieldCheck,
  Star, Tag, Trash2, TriangleAlert, X,
} from "lucide-react";
import { toast } from "sonner";
import { logout } from "@/app/actions/auth";
import { listDrive, moveItems, restoreItems } from "@/app/actions/drive";
import { lockFolder } from "@/app/actions/folder-security";
import { recordOpened } from "@/app/actions/drive-metadata";
import type { DriveFilter, DriveItem, DriveListInput, DriveSort, DriveTypeFilter } from "@/lib/drive-types";
import { optimisticDriveChange } from "@/lib/drive-cache";
import { beginMarquee, isDraggingItems, itemDropHandlers, type DropTarget } from "@/lib/drive-drag";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Filters, FilterChips, FilterAddButton, type FilterField, type FilterValue } from "@/components/ui/cubby-ui/filters/filters";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/cubby-ui/context-menu";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ThemeToggle } from "@/components/theme-toggle";
import { SoundToggle } from "@/components/ui/sound";
import { Spinner } from "@/components/spinner";
import { DriveItems, formatBytes } from "@/components/drive-item";
import type { DriveItemAction } from "@/components/drive-item";
import { McpConnectionDialog } from "@/components/mcp-connection-dialog";
import { DriveNameDialog, DrivePreviewDialog, DriveShareDialog, useDriveDownload } from "@/components/drive-dialogs";
import { DriveMoveDialog, DrivePasswordDialog, DriveTrashDialog } from "@/components/drive-management-dialogs";
import { DriveAccessError, FolderAccessProvider, useFolderAccess } from "@/components/folder-access";
import { useArchiveDownload } from "@/components/drive-archive";
import { DriveUploadQueue, useDriveUploads } from "@/components/drive-uploads";
import { CommandMenu } from "@/components/command-menu";
import { DriveMetadataDialog } from "@/components/drive-metadata-ui";
import { ScanFileDialog } from "@/components/file-scan-badge";

type FamilyUser = { name: string; email: string };
type OpenDialog = { kind: "folder"; parentId: string | null }
  | { kind: "rename" | "share" | "preview" | "password" | "details" | "scan"; item: DriveItem }
  | { kind: "move" | "trash" | "permanent"; items: DriveItem[] } | null;
type FilterValueMap = { type: DriveTypeFilter; tags: string[]; modified: { after: string; before: string }; size: { min: number | null; max: number | null } };
const typeOptions: { value: Exclude<DriveTypeFilter, "all">; label: string }[] = [
  { value: "folder", label: "Folders" },
  { value: "image", label: "Images" }, { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" }, { value: "pdf", label: "PDFs" },
  { value: "text", label: "Text" }, { value: "code", label: "Code" },
  { value: "archive", label: "Archives" }, { value: "other", label: "Other files" },
];
function ModifiedFilterValue({ value, onValueChange }: { value: FilterValueMap["modified"]; onValueChange: (value: FilterValueMap["modified"]) => void }) {
  const label = value.after || value.before ? `${value.after || "Any"} – ${value.before || "Any"}` : "Choose dates";
  return <Popover defaultOpen>
    <PopoverTrigger render={<Button variant="ghost" size="sm" className="h-7 max-w-32 rounded-none px-2" />} aria-label="Choose modified date range">
      <span className="truncate">{label}</span>
    </PopoverTrigger>
    <PopoverContent align="start" className="max-w-[calc(100vw-2rem)]">
      <PopoverTitle>Modified date</PopoverTitle>
      <FieldGroup className="gap-3">
        <Field><FieldLabel>From<Input type="date" aria-label="Modified after" max={value.before || undefined} value={value.after} onChange={(event) => onValueChange({ ...value, after: event.target.value })} /></FieldLabel></Field>
        <Field><FieldLabel>Through<Input type="date" aria-label="Modified before" min={value.after || undefined} value={value.before} onChange={(event) => onValueChange({ ...value, before: event.target.value })} /></FieldLabel></Field>
      </FieldGroup>
    </PopoverContent>
  </Popover>;
}
const filterFields: FilterField[] = [
  { id: "type", label: "Type", icon: <Files />, type: "select", operators: [{ id: "is", label: "is" }], options: typeOptions },
  { id: "tags", label: "Tags", icon: <Tag />, type: "text", operators: [{ id: "has", label: "includes" }], placeholder: "e.g. invoices, 2026" },
  {
    id: "modified", label: "Modified", icon: <CalendarRange />, type: "custom", defaultValue: { after: "", before: "" },
    renderValue: ({ value, onValueChange }) => {
      const modified = (value ?? { after: "", before: "" }) as FilterValueMap["modified"];
      return <ModifiedFilterValue value={modified} onValueChange={onValueChange} />;
    },
  },
  { id: "size", label: "Size", icon: <HardDrive />, type: "number", operators: [{ id: "between", label: "between", shape: "range" }], suffix: "MB" },
];
const sortOptions: { value: DriveSort; label: string }[] = [
  { value: "name", label: "Name" }, { value: "updatedAt", label: "Date modified" },
  { value: "size", label: "Size" }, { value: "type", label: "File type" },
];

const destinations = [
  { filter: "all", label: "All files", icon: Files },
  { filter: "recent", label: "Recent", icon: Clock3 },
  { filter: "favorites", label: "Favorites", icon: Star },
  { filter: "public", label: "Public links", icon: Link2 },
  { filter: "trash", label: "Trash", icon: Trash2 },
] as const;

function LogoutButton({ uploading }: { uploading: boolean }) {
  const { pending } = useFormStatus();
  return <Button type="submit" variant="ghost" size="icon" disabled={pending || uploading} aria-label={uploading ? "Wait for uploads to finish before signing out" : "Sign out"} title={uploading ? "Wait for uploads to finish" : "Sign out"}>{pending ? <Spinner /> : <LogOut />}</Button>;
}

function DriveSidebar({ user, filter, totalBytes, totalFiles, navigate, uploading, search, onSearch, collapsed = false, onExpand, onConnect }: {
  user: FamilyUser;
  filter: DriveFilter;
  totalBytes?: number;
  totalFiles?: number;
  navigate: (filter: DriveFilter, folderId?: string) => void;
  uploading: boolean;
  search: string;
  onSearch: (value: string) => void;
  collapsed?: boolean;
  onExpand?: () => void;
  onConnect: () => void;
}) {
  const labelClass = cn("origin-left whitespace-nowrap motion-safe:transition-[opacity,transform] motion-safe:duration-170", collapsed && "pointer-events-none w-0 -translate-x-1.5 scale-[.84] opacity-0");
  return <div className="flex h-full flex-col overflow-hidden">
    <button onClick={() => navigate("all")} aria-label="Orole Drive, all files" className={cn("flex h-12 shrink-0 items-center gap-2.5 overflow-hidden px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", collapsed && "justify-center gap-0")}>
      <Cloud className="size-5 shrink-0 text-primary" strokeWidth={1.7} />
      <span className={cn("text-[13px] font-medium", labelClass)}>Orole Drive</span>
    </button>
    <div className={cn("mt-2 px-3", collapsed && "flex justify-center")}>
      {collapsed ? <Button variant="ghost" size="icon" aria-label="Expand sidebar to search" onClick={onExpand}><Search /></Button> : <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input data-drive-search type="search" aria-label="Search family files" placeholder="Search files…" value={search} onChange={(event) => onSearch(event.target.value)} className="pl-8" />
      </div>}
    </div>
    <div className={cn("mt-6 overflow-hidden px-5 text-xs text-muted-foreground", labelClass)} aria-hidden={collapsed}>Family space</div>
    <nav aria-label="Drive navigation" className="mt-2 flex flex-col gap-0.5 px-3">
      {destinations.map(({ filter: value, label, icon: Icon }) => <button key={value} onClick={() => navigate(value)} aria-current={filter === value ? "page" : undefined} aria-label={label} title={collapsed ? label : undefined} className={cn("flex min-h-9 items-center gap-2.5 overflow-hidden rounded-lg px-2.5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors pointer-coarse:min-h-11", collapsed && "justify-center gap-0 px-0", filter === value ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/65 hover:text-foreground")}><Icon className="size-4 shrink-0" strokeWidth={1.6} /><span className={labelClass} aria-hidden={collapsed}>{label}</span></button>)}
    </nav>
    <div className="mt-auto flex flex-col gap-4 pt-10">
      <div className={cn("px-5", collapsed && "px-7")} title={totalBytes === undefined ? "Family storage unavailable" : `${formatBytes(totalBytes)} stored`}>
        <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", collapsed && "gap-0")}><HardDrive className="size-4 shrink-0" /><span className={labelClass} aria-hidden={collapsed}>Family storage</span></div>
        {!collapsed && <><p className="mt-2 text-xs tabular-nums">{totalBytes === undefined ? "Usage unavailable" : `${formatBytes(totalBytes)} stored`}</p>{totalFiles !== undefined && <p className="mt-1 text-xs text-muted-foreground">{totalFiles.toLocaleString()} {totalFiles === 1 ? "file" : "files"} in your family’s drive</p>}</>}
      </div>
      <div className="px-3"><Button variant="ghost" className={cn("w-full justify-start", collapsed && "justify-center px-0")} aria-label="Connect an agent with MCP" onClick={onConnect}><Plug /><span className={labelClass} aria-hidden={collapsed}>Connect an agent</span></Button></div>
      <Separator />
      <div className={cn("flex items-center gap-2 px-3 pb-3", collapsed && "flex-col")}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-medium" aria-hidden="true">{(user.name || user.email).slice(0, 1).toUpperCase()}</span>
        {!collapsed && <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{user.name || user.email.split("@")[0]}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground">{user.email}</p></div>}
        <form action={logout}><LogoutButton uploading={uploading} /></form>
      </div>
    </div>
  </div>;
}

export function DriveWorkspace({ user }: { user: FamilyUser }) {
  return <FolderAccessProvider><DriveWorkspaceContent user={user} /></FolderAccessProvider>;
}

function DriveWorkspaceContent({ user }: { user: FamilyUser }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const client = useQueryClient();
  const { run } = useFolderAccess();
  const folderId = params.get("folder") || null;
  const requestedFilter = params.get("view");
  const filter: DriveFilter = requestedFilter === "public" || requestedFilter === "recent" || requestedFilter === "trash" || requestedFilter === "favorites" ? requestedFilter : "all";
  const trash = filter === "trash";
  const [search, setSearch] = useState("");
  const [filterValues, setFilterValues] = useState<FilterValue[]>([]);
  const [sort, setSort] = useState<DriveSort | "activity">(filter === "recent" ? "activity" : "name");
  const [direction, setDirection] = useState<"asc" | "desc">(filter === "recent" ? "desc" : "asc");
  const availableSorts = filter === "recent" ? [{ value: "activity" as const, label: "Last opened/uploaded" }, ...sortOptions] : sortOptions;
  const deferredSearch = useDeferredValue(search.trim());
  const deferredFilterValues = useDeferredValue(filterValues);
  const [view, setView] = useState<"grid" | "list">("list");
  const [mobileNav, setMobileNav] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
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
  const deferredTypeFilter = deferredFilterValues.find((entry) => entry.field === "type");
  const deferredTagsFilter = deferredFilterValues.find((entry) => entry.field === "tags");
  const deferredModifiedFilter = deferredFilterValues.find((entry) => entry.field === "modified");
  const deferredSizeFilter = deferredFilterValues.find((entry) => entry.field === "size");
  const deferredModified = (deferredModifiedFilter?.value ?? { after: "", before: "" }) as FilterValueMap["modified"];
  const deferredSize = (deferredSizeFilter?.value ?? { min: null, max: null }) as FilterValueMap["size"];
  const deferredTags = typeof deferredTagsFilter?.value === "string" ? deferredTagsFilter.value.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
  const input: DriveListInput = {
    folderId, filter, search: deferredSearch,
    type: (typeof deferredTypeFilter?.value === "string" ? deferredTypeFilter.value : "all") as DriveListInput["type"],
    minSize: deferredSize.min === null ? undefined : Math.round(deferredSize.min * 1024 * 1024),
    maxSize: deferredSize.max === null ? undefined : Math.round(deferredSize.max * 1024 * 1024),
    after: deferredModified.after || undefined, before: deferredModified.before || undefined,
    tags: deferredTags.length ? deferredTags : undefined,
    sort: sort === "activity" ? undefined : sort, direction,
  };
  const queryKey = ["drive", input];
  const scope = JSON.stringify(input);
  const [selection, setSelection] = useState<{ scope: string; ids: Set<string> }>({ scope: "", ids: new Set() });
  const selected = selection.scope === scope ? selection.ids : new Set<string>();
  if (selection.scope !== scope && selection.ids.size > 0) setSelection({ scope, ids: new Set() });
  const listing = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await listDrive(input);
      if (!result.success) throw new DriveAccessError(result.error, result.lockedFolder);
      return result.data;
    },
    placeholderData: (previous, previousQuery) => {
      const previousInput = previousQuery?.queryKey[1] as DriveListInput | undefined;
      return previousInput?.folderId === folderId && previousInput?.filter === filter ? previous : undefined;
    },
    retry: false,
    staleTime: 15_000,
  });
  const data = listing.data;
  const items = data?.items ?? [];
  const selectedItems = items.filter((item) => selected.has(item.id));
  const breadcrumbs = data?.breadcrumbs ?? [];
  const currentFolder = data?.currentFolder;
  const attributesActive = Boolean(input.type !== "all" || input.tags?.length || input.after || input.before || input.minSize !== undefined || input.maxSize !== undefined);
  const globalSearch = Boolean(search.trim()) || attributesActive;
  const locked = listing.error instanceof DriveAccessError ? listing.error.lockedFolder : undefined;
  const title = globalSearch ? (trash ? "Search Trash" : "Search results") : currentFolder?.name ?? (trash ? "Trash" : filter === "public" ? "Public links" : filter === "recent" ? "Recent" : filter === "favorites" ? "Favorites" : "All files");
  const destination = currentFolder?.name ?? "All files";
  const canUpload = !trash && !locked && !listing.error && !listing.isPending;

  function clearSelection() { setSelection({ scope, ids: new Set() }); rangeAnchor.current = null; }
  function completeMutation() { setDialog(null); clearSelection(); }
  const restore = useMutation({
    mutationFn: (ids: string[]) => run(() => restoreItems(ids)),
    onMutate: async (ids) => ({ rollback: await optimisticDriveChange(client, { kind: "restore", ids }) }),
    onError: (error, _ids, context) => { context?.rollback(); toast.error(error.message); },
    onSuccess: (result) => {
      toast.success(result.restoredToRoot ? `Restored. ${result.restoredToRoot} ${result.restoredToRoot === 1 ? "item was" : "items were"} placed in All files because the original folder is unavailable.` : "Restored to original location");
      clearSelection();
    },
    onSettled: () => { void client.invalidateQueries({ queryKey: ["drive"] }); },
  });
  const moveDrop = useMutation({
    mutationFn: ({ ids, target }: { ids: string[]; target: DropTarget }) => run(() => moveItems({ ids, parentId: target.id })),
    onMutate: async ({ ids, target }) => ({ rollback: await optimisticDriveChange(client, { kind: "move", ids, parentId: target.id }) }),
    onError: (error, _variables, context) => { context?.rollback(); toast.error(error.message); },
    onSuccess: (_result, { ids, target }) => { toast.success(`${ids.length === 1 ? "Item" : `${ids.length} items`} moved to ${target.name}`); clearSelection(); },
    onSettled: () => { void client.invalidateQueries({ queryKey: ["drive"] }); },
  });
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [crumbDrop, setCrumbDrop] = useState<string | null | undefined>();
  const moveTo = (ids: string[], target: DropTarget) => { if (!actionsDisabled) moveDrop.mutate({ ids, target }); };
  const crumbDropProps = (target: DropTarget) => trash || globalSearch ? {} : itemDropHandlers(target, { onMove: moveTo, onOver: setCrumbDrop });
  const crumbDropClass = (id: string | null) => crumbDrop === id && "bg-primary/10 text-foreground ring-2 ring-primary/60";
  const lock = useMutation({
    mutationFn: (id: string) => run(() => lockFolder(id)),
    onSuccess: () => { window.dispatchEvent(new Event("drive-access-changed")); toast.success("Folder locked"); },
    onError: (error) => toast.error(error.message),
  });
  const stale = listing.isPlaceholderData || deferredSearch !== search.trim() || deferredFilterValues !== filterValues;
  const actionsDisabled = stale || opening || restore.isPending || lock.isPending || moveDrop.isPending;

  function navigate(nextFilter: DriveFilter, nextFolder?: string) {
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
    window.history.pushState(null, "", `${pathname}${next.size ? `?${next}` : ""}`);
  }
  async function openItem(item: DriveItem) {
    if (actionsDisabled) return;
    if (item.kind === "file") { if (!trash) { setDialog({ kind: "preview", item }); void recordOpened(item.id); } return; }
    const nextInput: DriveListInput = { folderId: item.id, filter: trash ? "trash" : "all", search: "", type: "all", sort: sort === "activity" ? undefined : sort, direction };
    setOpening(true);
    try {
      const result = await run(() => listDrive(nextInput));
      client.setQueryData(["drive", nextInput], result);
      navigate(trash ? "trash" : "all", item.id);
      if (!trash) void recordOpened(item.id);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not open folder."); }
    finally { setOpening(false); }
  }
  function prefetchFolder(item: DriveItem) {
    if (item.kind !== "folder" || item.isLocked || trash || actionsDisabled) return;
    const nextInput: DriveListInput = { folderId: item.id, filter: "all", search: "", type: "all", sort: sort === "activity" ? undefined : sort, direction };
    void client.prefetchQuery({
      queryKey: ["drive", nextInput],
      queryFn: async () => {
        const result = await listDrive(nextInput);
        if (!result.success) throw new DriveAccessError(result.error, result.lockedFolder);
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
      for (let index = Math.min(start, end); index <= Math.max(start, end); index++) ids.add(items[index].id);
    } else {
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      rangeAnchor.current = id;
    }
    setSelection({ scope, ids });
  }
  function uploadFiles(parentId: string | null) { uploadTarget.current = parentId; fileInput.current?.click(); }
  function onItemAction(action: DriveItemAction, targets: DriveItem[]) {
    if (actionsDisabled || !targets.length) return;
    const item = targets[0];
    if (action === "open") void openItem(item);
    else if (action === "download") {
      if (targets.length === 1 && item.kind === "file") download.mutate(item.id);
      else archive.start(targets.map((target) => target.id));
    } else if (action === "restore") restore.mutate(targets.map((target) => target.id));
    else if (action === "lock") lock.mutate(item.id);
    else if (action === "move" || action === "trash" || action === "permanent") setDialog({ kind: action, items: targets });
    else if (action === "upload-files") uploadFiles(item.id);
    else if (action === "upload-folder") uploads.chooseFolder(item.id);
    else if (action === "new-folder") setDialog({ kind: "folder", parentId: item.id });
    else setDialog({ kind: action, item });
  }
  async function unlockCurrent() {
    setOpening(true);
    try { client.setQueryData(queryKey, await run(() => listDrive(input))); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not unlock folder."); }
    finally { setOpening(false); }
  }

  useEffect(() => {
    function accessChanged() {
      setDialog(null);
      setSelection({ scope: "", ids: new Set() });
      client.removeQueries({ predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("drive-") });
      void client.resetQueries({ queryKey: ["drive"] });
    }
    window.addEventListener("drive-access-changed", accessChanged);
    return () => window.removeEventListener("drive-access-changed", accessChanged);
  }, [client]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("[role=dialog], [role=alertdialog]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      } else if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !target?.closest("input, textarea, select, [contenteditable=true], [role=menu]")) {
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
      if (!event.dataTransfer?.types.includes("Files") || isDraggingItems()) return;
      event.preventDefault();
      depth++;
      if (canUpload) setDragging(true);
    }
    function over(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files") || isDraggingItems()) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = canUpload ? "copy" : "none";
    }
    function leave(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files") || isDraggingItems()) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    }
    function reset() { depth = 0; setDragging(false); }
    function drop(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files") || isDraggingItems()) return;
      event.preventDefault();
      reset();
      if (canUpload) addDrop(event.dataTransfer, folderId);
      else toast.error(trash ? "Open All files or a folder to upload." : "Unlock this folder before uploading.");
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
  }, [folderId, canUpload, trash, addDrop]);
  useEffect(() => {
    function paste(event: ClipboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=alertdialog]")) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      if (canUpload) addFiles(files, folderId);
      else toast.error(trash ? "Open a folder outside Trash to paste files." : "Unlock this folder before pasting files.");
    }
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [canUpload, folderId, trash, addFiles]);

  const uploadActions = <>
    <Button variant="secondary" size="sm" disabled={!canUpload} onClick={() => uploadFiles(folderId)}><ArrowUp data-icon="inline-start" />Upload files</Button>
    <Button variant="outline" size="sm" disabled={!canUpload} onClick={() => uploads.chooseFolder(folderId)}><FolderUp data-icon="inline-start" />Upload folder</Button>
    <Button variant="outline" size="sm" disabled={!canUpload} onClick={() => setDialog({ kind: "folder", parentId: folderId })}><FolderPlus data-icon="inline-start" />New folder</Button>
  </>;
  return <div className="flex min-h-dvh bg-background">
    <a href="#drive-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-3 focus:ring-2 focus:ring-ring">Skip to files</a>
    <aside id="drive-sidebar" className={cn("sticky top-0 hidden h-dvh shrink-0 border-r border-sidebar-border bg-sidebar md:block motion-safe:transition-[width] motion-safe:duration-[240ms] motion-safe:ease-[cubic-bezier(.5,0,.1,1)]", collapsed ? "w-[72px]" : "w-[230px]")}>
      <DriveSidebar user={user} filter={filter} totalBytes={data?.totalBytes} totalFiles={data?.totalFiles} navigate={navigate} uploading={uploads.pending > 0} search={search} onSearch={setSearch} collapsed={collapsed} onExpand={() => setCollapsed(false)} onConnect={() => setMcpOpen(true)} />
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/65 bg-background/95 px-3 backdrop-blur-sm sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Button className="md:hidden" variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu /></Button>
          <Button className="hidden md:inline-flex" variant="ghost" size="icon" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} aria-controls="drive-sidebar" onClick={() => setCollapsed(!collapsed)}><PanelLeft /></Button>
          <span className="truncate text-[13px] font-medium">Family space</span>
        </div>
        <div className="flex items-center gap-2"><Button variant="ghost" size="icon" aria-label="Open command menu" title="Command menu (Ctrl or ⌘ K)" onClick={() => setCommandOpen(true)}><Search /></Button><span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"><ShieldCheck className="size-3.5" />Private workspace</span><SoundToggle className="size-8 rounded-lg" /><ThemeToggle /></div>
      </header>
      <ContextMenu>
        <ContextMenuTrigger render={<main id="drive-content" tabIndex={-1} className="flex flex-1 flex-col px-4 pb-16 pt-7 outline-none sm:px-7 lg:px-9" />}
          onKeyDown={(event) => {
            if (event.defaultPrevented) return;
            const target = event.target as HTMLElement;
            if (target.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !actionsDisabled) {
              event.preventDefault();
              setSelection({ scope, ids: new Set(items.map((item) => item.id)) });
            } else if (event.key === "Escape") clearSelection();
            else if (!actionsDisabled && (event.key === "F2" || event.key === "Delete" || event.key === " ")) {
              const focusedId = target.closest<HTMLElement>("[data-drive-item]")?.dataset.driveItem;
              const focusedItem = items.find((item) => item.id === focusedId);
              const targets = selectedItems.length ? selectedItems : focusedItem ? [focusedItem] : [];
              if (!targets.length) return;
              if (event.key === "F2" && !trash && targets.length === 1) {
                event.preventDefault();
                setDialog({ kind: "rename", item: targets[0] });
              } else if (event.key === "Delete") {
                event.preventDefault();
                setDialog({ kind: trash ? "permanent" : "trash", items: targets });
              } else if (event.key === " " && !trash && targets.length === 1 && targets[0].kind === "file" && !target.closest("[role=checkbox], [aria-haspopup]")) {
                event.preventDefault();
                void openItem(targets[0]);
              }
            }
          }}>
          <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="max-w-[80vw] truncate text-xl font-medium tracking-[-0.025em] md:max-w-[50vw]" title={title}>{title}</h1>
                <p className="mt-1.5 max-w-lg text-xs leading-relaxed text-muted-foreground">{trash ? "Items stay in Trash for 30 days. Restoring does not restore public links." : globalSearch ? "Searching all accessible folders in your family’s drive." : filter === "public" ? "Files accessible to anyone with a link." : filter === "recent" ? "Your family’s latest additions and changes." : filter === "favorites" ? "Files and folders you’ve starred." : currentFolder ? "Only your family can access this folder." : "Your family’s files, all in one place."}</p>
              </div>
              {!trash && <div className="flex flex-wrap items-center gap-2">{uploadActions}</div>}
            </div>
            <div className="mb-4 mt-5 flex flex-wrap items-center justify-between gap-3">
              <nav aria-label="Folder breadcrumbs" className="min-w-0 max-w-full overflow-x-auto">
                <ol className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                  <li><button onClick={() => navigate(trash ? "trash" : "all")} {...(folderId ? crumbDropProps({ id: null, name: "All files" }) : {})} className={cn("min-h-8 rounded px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", crumbDropClass(null))}>{trash ? "Trash" : "All files"}</button></li>
                  {breadcrumbs.map((crumb, index) => <li key={crumb.id} className="flex items-center gap-1"><ChevronRight className="size-3 shrink-0" /><button onClick={() => navigate(trash ? "trash" : "all", crumb.id)} aria-current={!globalSearch && index === breadcrumbs.length - 1 ? "page" : undefined} {...(index < breadcrumbs.length - 1 ? crumbDropProps({ id: crumb.id, name: crumb.name }) : {})} className={cn("min-h-8 max-w-36 truncate rounded px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", crumbDropClass(crumb.id))}>{crumb.name}</button></li>)}
                  {globalSearch && <li className="flex items-center gap-1"><ChevronRight className="size-3" /><span aria-current="page">All-folder results</span></li>}
                </ol>
              </nav>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {currentFolder?.hasPassword && !trash && <Button variant="ghost" size="icon-sm" disabled={actionsDisabled} aria-label="Lock this folder" onClick={() => lock.mutate(currentFolder.id)}><LockKeyhole /></Button>}
                {data && <Badge variant="secondary">{items.length} {items.length === 1 ? "item" : "items"}</Badge>}
                <ToggleGroup value={[view]} onValueChange={(value) => { if (value[0] === "grid" || value[0] === "list") setView(value[0]); }} size="sm" spacing={0} aria-label="File view">
                  <ToggleGroupItem value="list" aria-label="List view"><List /></ToggleGroupItem>
                  <ToggleGroupItem value="grid" aria-label="Grid view"><LayoutGrid /></ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>
            <section aria-label="Search and filters" className="mb-5 flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input id="drive-global-search" data-drive-search type="search" aria-label="Search file names" value={search} placeholder="Search file names…" onChange={(event) => setSearch(event.target.value)} className="pl-8" />
              </div>
              <Filters fields={filterFields} value={filterValues} onValueChange={setFilterValues} size="sm" className="max-w-full">
                <FilterChips /><FilterAddButton shortcut="f" />
              </Filters>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {(search || filterValues.length > 0) && <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setFilterValues([]); }}><X data-icon="inline-start" />Clear</Button>}
                <Select value={sort} items={availableSorts} onValueChange={(value) => { if (value) setSort(value); }}>
                  <SelectTrigger size="sm" aria-label="Sort by" className="w-auto"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{availableSorts.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
                <Button variant="outline" size="icon-sm" onClick={() => setDirection(direction === "asc" ? "desc" : "asc")} aria-label={`Sort ${direction === "asc" ? "descending" : "ascending"}`}>
                  <ArrowDownWideNarrow className={cn(direction === "desc" && "rotate-180")} />
                </Button>
              </div>
            </section>
            <div aria-live="polite" role="status" className="mb-3 flex min-h-5 items-center gap-2 text-xs text-muted-foreground">{(listing.isFetching || stale || opening) && <><Spinner size={12} />{opening ? "Opening folder…" : data ? "Updating files…" : "Loading files…"}</>}</div>
            {data && !listing.error && items.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-2" aria-label="Selection actions">
              <div className="flex min-h-8 items-center gap-3 pr-2"><Checkbox id="drive-select-all" checked={selectedItems.length === items.length} indeterminate={selectedItems.length > 0 && selectedItems.length < items.length} disabled={actionsDisabled} onCheckedChange={(checked) => { setSelection({ scope, ids: checked ? new Set(items.map((item) => item.id)) : new Set() }); }} /><label htmlFor="drive-select-all" className="cursor-pointer text-xs">{selectedItems.length ? `${selectedItems.length} selected` : "Select all"}</label></div>
              {selectedItems.length > 0 && <>
                {trash ? <><Button variant="outline" size="sm" disabled={actionsDisabled} onClick={() => restore.mutate(selectedItems.map((item) => item.id))}><RotateCcw />Restore</Button><Button variant="outline" size="sm" disabled={actionsDisabled} onClick={() => setDialog({ kind: "permanent", items: selectedItems })}><Trash2 />Delete permanently</Button></> : <><Button variant="outline" size="sm" disabled={actionsDisabled || archive.isPending} onClick={() => archive.start(selectedItems.map((item) => item.id))}><Download />Download ZIP</Button><Button variant="outline" size="sm" disabled={actionsDisabled} onClick={() => setDialog({ kind: "move", items: selectedItems })}><FolderInput />Move</Button><Button variant="outline" size="sm" disabled={actionsDisabled} onClick={() => setDialog({ kind: "trash", items: selectedItems })}><Trash2 />Move to Trash</Button></>}
                <Button variant="ghost" size="sm" onClick={clearSelection}>Clear selection</Button>
              </>}
            </div>}
            <div className="flex flex-1 flex-col" aria-busy={listing.isFetching || stale || opening} onPointerDown={(event) => { if (!actionsDisabled && items.length) beginMarquee(event, { selected, onSelect: (ids) => setSelection({ scope, ids }), onBox: setMarquee }); }}>
              {marquee && <div aria-hidden="true" className="pointer-events-none fixed z-50 rounded-sm border border-primary/70 bg-primary/10" style={marquee} />}
              {listing.isPending ? <div aria-label="Loading files" className="flex flex-col gap-5 py-3">{Array.from({ length: 5 }, (_, index) => <div key={index} className="flex items-center gap-3"><Skeleton className="size-10 rounded-xl" /><div className="flex flex-1 flex-col gap-2"><Skeleton className="h-3 w-2/5" /><Skeleton className="h-2 w-1/5" /></div><Skeleton className="h-3 w-16" /></div>)}</div>
                : locked ? <Empty className="mx-auto my-auto max-w-md border-0 px-0 py-12"><EmptyHeader><EmptyMedia><LockKeyhole className="size-10 text-muted-foreground" strokeWidth={1.2} /></EmptyMedia><EmptyTitle>This folder is locked</EmptyTitle><EmptyDescription>Enter the password for “{locked.name}” to see its files.</EmptyDescription></EmptyHeader><EmptyContent><Button disabled={opening} onClick={() => void unlockCurrent()}>{opening && <Spinner />}Unlock folder</Button><Button variant="ghost" onClick={() => navigate(trash ? "trash" : "all")}>Back to {trash ? "Trash" : "All files"}</Button></EmptyContent></Empty>
                : listing.error ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>We couldn’t load your files</AlertTitle><AlertDescription><p>{listing.error.message}</p><div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => void listing.refetch()}>Try again</Button>{globalSearch && <Button variant="outline" size="sm" onClick={() => { setSearch(""); setFilterValues([]); }}>Clear filters</Button>}{folderId && <Button variant="outline" size="sm" onClick={() => navigate(trash ? "trash" : "all")}>Back to {trash ? "Trash" : "All files"}</Button>}</div></AlertDescription></Alert>
                : items.length ? <DriveItems items={items} view={view} selected={selected} trash={trash} disabled={actionsDisabled} onSelect={selectItem} onOpen={(item) => void openItem(item)} onOpenIntent={prefetchFolder} onAction={onItemAction} onMove={moveTo} />
                : <Empty className="mx-auto my-auto w-full max-w-md border-0 px-0 py-12">
                  <EmptyHeader><EmptyMedia>{globalSearch ? <Search className="size-10 text-muted-foreground" strokeWidth={1.2} /> : trash ? <Trash2 className="size-10 text-muted-foreground" strokeWidth={1.2} /> : filter === "public" ? <Link2 className="size-10 text-muted-foreground" strokeWidth={1.2} /> : filter === "favorites" ? <Star className="size-10 text-muted-foreground" strokeWidth={1.2} /> : <Folder className="size-12 text-muted-foreground" strokeWidth={1.1} />}</EmptyMedia><EmptyTitle>{globalSearch ? "No matching files" : trash ? "Nothing to restore" : filter === "public" ? "No public links" : filter === "favorites" ? "No favorites yet" : currentFolder ? "This folder is empty" : "Make room for your files"}</EmptyTitle><EmptyDescription>{globalSearch ? "Try a different name, or clear the filters to see more files." : trash ? "Items you move to Trash will appear here for 30 days." : filter === "public" ? "Create a public link from a file’s menu when you want to share it outside your family." : filter === "favorites" ? "Star a file or folder from its menu to find it here quickly." : currentFolder ? `Add files to “${currentFolder.name}”, or create a folder to keep things organized.` : "Upload files or a whole folder to your family’s private drive."}</EmptyDescription></EmptyHeader>
                  <EmptyContent className="w-full">{globalSearch ? <Button variant="outline" onClick={() => { setSearch(""); setFilterValues([]); }}>Clear filters</Button> : trash || filter === "public" || filter === "favorites" ? <Button variant="outline" onClick={() => navigate("all")}>Browse all files</Button> : <><div className="flex flex-wrap justify-center gap-2">{uploadActions}</div><p className="text-xs text-muted-foreground">Or drop files and folders here.</p></>}</EmptyContent>
                </Empty>}
            </div>
            {canUpload && items.length > 0 && <p className="mt-auto pt-8 text-center text-xs text-muted-foreground">Drop files or folders to upload to {destination}.</p>}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent><ContextMenuGroup>
          <ContextMenuItem disabled={!canUpload} onClick={() => uploadFiles(folderId)}><ArrowUp />Upload files</ContextMenuItem>
          <ContextMenuItem disabled={!canUpload} onClick={() => uploads.chooseFolder(folderId)}><FolderUp />Upload folder</ContextMenuItem>
          <ContextMenuItem disabled={!canUpload} onClick={() => setDialog({ kind: "folder", parentId: folderId })}><FolderPlus />New folder</ContextMenuItem>
        </ContextMenuGroup></ContextMenuContent>
      </ContextMenu>
    </div>
    <input ref={fileInput} type="file" multiple className="hidden" aria-label="Choose files to upload" onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) uploads.addFiles(files, uploadTarget.current); event.target.value = ""; }} />
    <Dialog open={mobileNav} onOpenChange={setMobileNav}><DialogContent className="h-[min(680px,90dvh)] sm:max-w-sm"><DialogHeader className="sr-only"><DialogTitle>Drive navigation</DialogTitle><DialogDescription>Browse your family’s shared files and manage your account.</DialogDescription></DialogHeader><DriveSidebar user={user} filter={filter} totalBytes={data?.totalBytes} totalFiles={data?.totalFiles} navigate={navigate} uploading={uploads.pending > 0} search={search} onSearch={setSearch} onConnect={() => { setMobileNav(false); setMcpOpen(true); }} /></DialogContent></Dialog>
    <McpConnectionDialog open={mcpOpen} onOpenChange={setMcpOpen} />
    <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} onNavigate={navigate} onOpenItem={(item) => void openItem(item)} />
    {dialog?.kind === "folder" && <DriveNameDialog parentId={dialog.parentId} onClose={completeMutation} />}
    {dialog?.kind === "rename" && <DriveNameDialog key={dialog.item.id} item={dialog.item} parentId={folderId} onClose={completeMutation} />}
    {dialog?.kind === "share" && <DriveShareDialog key={dialog.item.id} item={dialog.item} onClose={() => setDialog(null)} />}
    {dialog?.kind === "preview" && <DrivePreviewDialog key={dialog.item.id} item={dialog.item} onClose={() => setDialog(null)} />}
    {dialog?.kind === "move" && <DriveMoveDialog items={dialog.items} onClose={() => setDialog(null)} onComplete={completeMutation} />}
    {(dialog?.kind === "trash" || dialog?.kind === "permanent") && <DriveTrashDialog items={dialog.items} permanent={dialog.kind === "permanent"} onClose={() => setDialog(null)} onComplete={completeMutation} />}
    {dialog?.kind === "password" && <DrivePasswordDialog item={dialog.item} onClose={() => setDialog(null)} onComplete={completeMutation} />}
    {dialog?.kind === "scan" && <ScanFileDialog key={dialog.item.id} item={dialog.item} onClose={() => setDialog(null)} />}
    {dialog?.kind === "details" && <DriveMetadataDialog key={dialog.item.id} item={dialog.item} onClose={() => setDialog(null)} />}
    {archive.dialog}
    <DriveUploadQueue uploads={uploads} />
    {dragging && <div className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/95" role="status"><div className="flex flex-col items-center gap-4 px-6 text-center"><CloudUpload className="size-12 text-primary" strokeWidth={1.4} /><p className="text-xl font-medium tracking-tight">Drop files or folders to upload</p><p className="text-sm text-muted-foreground">Add to {destination}</p></div></div>}
  </div>;
}
