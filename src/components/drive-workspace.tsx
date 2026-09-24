"use client";

import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp, ChevronRight, Clock3, Cloud, CloudUpload, Files, FolderPlus,
  HardDrive, LayoutGrid, Link2, List, LockKeyhole, LogOut, Menu,
  PanelLeft, Search, ShieldCheck, TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { logout } from "@/app/actions/auth";
import { listDrive } from "@/app/actions/drive";
import type { DriveFilter, DriveItem } from "@/lib/drive-types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ThemeToggle } from "@/components/theme-toggle";
import { Spinner } from "@/components/spinner";
import { DriveItems, formatBytes, type DriveItemAction } from "@/components/drive-item";
import { DriveDeleteDialog, DriveNameDialog, DrivePreviewDialog, DriveShareDialog, useDriveDownload } from "@/components/drive-dialogs";
import { DriveUploadQueue, useDriveUploads } from "@/components/drive-uploads";

type FamilyUser = { name: string; email: string };
type OpenDialog = { kind: "folder" } | { kind: "rename" | "delete" | "share" | "preview"; item: DriveItem } | null;

const destinations = [
  { filter: "all", label: "All files", icon: Files },
  { filter: "recent", label: "Recent", icon: Clock3 },
  { filter: "public", label: "Public links", icon: Link2 },
] as const;

function LogoutButton({ uploading }: { uploading: boolean }) {
  const { pending } = useFormStatus();
  return <Button type="submit" variant="ghost" size="icon" disabled={pending || uploading} aria-label={uploading ? "Wait for uploads to finish before signing out" : "Sign out"} title={uploading ? "Wait for uploads to finish" : "Sign out"}>{pending ? <Spinner /> : <LogOut />}</Button>;
}

function DriveSidebar({ user, filter, totalBytes, totalFiles, navigate, uploading, search, onSearch, collapsed = false, onExpand }: {
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
  const pathname = usePathname();
  const params = useSearchParams();
  const folderId = params.get("folder") || null;
  const requestedFilter = params.get("view");
  const filter: DriveFilter = requestedFilter === "public" || requestedFilter === "recent" ? requestedFilter : "all";
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [view, setView] = useState<"grid" | "list">("list");
  const [mobileNav, setMobileNav] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploads = useDriveUploads();
  const { addFiles } = uploads;
  const download = useDriveDownload();
  const listing = useQuery({
    queryKey: ["drive", folderId, filter, deferredSearch],
    queryFn: async () => {
      const result = await listDrive({ folderId, filter, search: deferredSearch });
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    retry: false,
    staleTime: 15_000,
  });
  const data = listing.data;
  const breadcrumbs = data?.breadcrumbs ?? [];
  const currentFolder = breadcrumbs.at(-1);
  const title = search.trim() ? "Search results" : currentFolder?.name ?? (filter === "public" ? "Public links" : filter === "recent" ? "Recent" : "All files");
  const destination = currentFolder?.name ?? "All files";

  function navigate(nextFilter: DriveFilter, nextFolder?: string) {
    const next = new URLSearchParams();
    if (nextFilter !== "all") next.set("view", nextFilter);
    if (nextFolder) next.set("folder", nextFolder);
    setSearch("");
    setMobileNav(false);
    window.history.pushState(null, "", `${pathname}${next.size ? `?${next}` : ""}`);
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCollapsed(false);
        if (window.matchMedia("(max-width: 767px)").matches) setMobileNav(true);
        requestAnimationFrame(() => Array.from(document.querySelectorAll<HTMLInputElement>("[data-drive-search]")).find((input) => input.getClientRects().length > 0)?.focus());
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
      depth += 1;
      setDragging(true);
    }
    function over(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
    function leave(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    }
    function reset() { depth = 0; setDragging(false); }
    function drop(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      reset();
      const transfer = event.dataTransfer;
      const files: File[] = [];
      let containsFolders = false;
      if (transfer.items.length) {
        for (const item of Array.from(transfer.items)) {
          if (item.kind !== "file") continue;
          if (item.webkitGetAsEntry?.()?.isDirectory) { containsFolders = true; continue; }
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      } else files.push(...Array.from(transfer.files));
      if (containsFolders) toast.error("Folder drops are not supported. Create a folder, then upload its files.");
      if (files.length) addFiles(files, folderId);
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
  }, [folderId, addFiles]);

  function onItemAction(action: DriveItemAction, item: DriveItem) {
    if (action === "download") download.mutate(item.id);
    else setDialog({ kind: action, item });
  }

  return <div className="flex min-h-dvh bg-background">
    <a href="#drive-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-3 focus:ring-2 focus:ring-ring">Skip to files</a>
    <aside id="drive-sidebar" className={cn("sticky top-0 hidden h-dvh shrink-0 border-r border-sidebar-border bg-sidebar md:block motion-safe:transition-[width] motion-safe:duration-[240ms] motion-safe:ease-[cubic-bezier(.5,0,.1,1)]", collapsed ? "w-[72px]" : "w-[230px]")}>
      <DriveSidebar user={user} filter={filter} totalBytes={data?.totalBytes} totalFiles={data?.totalFiles} navigate={navigate} uploading={uploads.pending > 0} search={search} onSearch={setSearch} collapsed={collapsed} onExpand={() => setCollapsed(false)} />
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/65 bg-background/95 px-3 backdrop-blur-sm sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Button className="md:hidden" variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu /></Button>
          <Button className="hidden md:inline-flex" variant="ghost" size="icon" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} aria-controls="drive-sidebar" onClick={() => setCollapsed(!collapsed)}><PanelLeft /></Button>
          <span className="truncate text-[13px] font-medium">Family space</span>
        </div>
        <div className="flex items-center gap-3"><span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"><ShieldCheck className="size-3.5" />Private workspace</span><ThemeToggle /></div>
      </header>
      <main id="drive-content" tabIndex={-1} className="flex flex-1 flex-col px-4 pb-16 pt-7 outline-none sm:px-7 lg:px-9">
        <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="max-w-[70vw] truncate text-xl font-medium tracking-[-0.025em] md:max-w-[50vw]" title={title}>{title}</h1>
              {(search.trim() || filter !== "all") && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{search.trim() ? `Results for “${search.trim()}”${currentFolder ? ` in ${currentFolder.name}` : ""}` : filter === "public" ? "Files accessible to anyone with a link." : "Your family’s latest additions and changes."}</p>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => { setSearch(""); if (filter !== "all") navigate("all", folderId ?? undefined); setDialog({ kind: "folder" }); }}><FolderPlus data-icon="inline-start" />New folder</Button>
              <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}><ArrowUp data-icon="inline-start" />Upload files</Button>
            </div>
          </div>
          <div className="mb-5 mt-5 flex min-h-8 items-center justify-between gap-3">
            <nav aria-label="Folder breadcrumbs" className="min-w-0 overflow-x-auto">
              <ol className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                <li><button onClick={() => navigate("all")} className="rounded px-1 py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">All files</button></li>
                {filter !== "all" && !folderId && <li className="flex items-center gap-1"><ChevronRight className="size-3" /><span aria-current="page">{filter === "public" ? "Public links" : "Recent"}</span></li>}
                {breadcrumbs.map((crumb, index) => <li key={crumb.id} className="flex items-center gap-1"><ChevronRight className="size-3" /><button onClick={() => navigate("all", crumb.id)} aria-current={index === breadcrumbs.length - 1 ? "page" : undefined} className="max-w-36 truncate rounded px-1 py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{crumb.name}</button></li>)}
              </ol>
            </nav>
            <div className="ml-auto flex shrink-0 items-center gap-3">
              {listing.isFetching && !listing.isPending && <Spinner label="Refreshing files" size={14} />}
              {data && <Badge variant="secondary">{data.items.length} {data.items.length === 1 ? "item" : "items"}</Badge>}
              <ToggleGroup value={[view]} onValueChange={(value) => { if (value[0] === "grid" || value[0] === "list") setView(value[0]); }} size="sm" spacing={0} aria-label="File view">
                <ToggleGroupItem value="list" aria-label="List view"><List /></ToggleGroupItem>
                <ToggleGroupItem value="grid" aria-label="Grid view"><LayoutGrid /></ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>
          {listing.isPending ? <div aria-label="Loading files" aria-busy="true" className="flex flex-col gap-5 py-3">{Array.from({ length: 5 }, (_, index) => <div key={index} className="flex items-center gap-3"><Skeleton className="size-10 rounded-xl" /><div className="flex flex-1 flex-col gap-2"><Skeleton className="h-3 w-2/5" /><Skeleton className="h-2 w-1/5" /></div><Skeleton className="h-3 w-16" /></div>)}<span className="sr-only">Loading your family’s files</span></div>
            : listing.error ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>We couldn’t load your files</AlertTitle><AlertDescription><p>{listing.error.message}</p><div className="mt-3 flex gap-2"><Button variant="outline" size="sm" onClick={() => void listing.refetch()}>Try again</Button>{folderId && <Button variant="outline" size="sm" onClick={() => navigate("all")}>Back to all files</Button>}</div></AlertDescription></Alert>
            : data?.items.length ? <DriveItems items={data.items} view={view} onOpen={(item) => item.kind === "folder" ? navigate("all", item.id) : setDialog({ kind: "preview", item })} onAction={onItemAction} />
            : <Empty className="mx-auto my-auto w-full max-w-[760px] border-0 px-0 pb-20 pt-12">
              <EmptyHeader><EmptyMedia><span className="mb-2 flex size-14 items-center justify-center rounded-2xl bg-primary/8 shadow-sm"><CloudUpload className="size-8 text-primary" strokeWidth={1.3} /></span></EmptyMedia><EmptyTitle><h2 className="text-xl font-medium tracking-tight">{search.trim() ? "No matching files" : filter === "public" ? "No public links" : currentFolder ? "This folder is empty" : "Your family’s shared drive"}</h2></EmptyTitle><EmptyDescription>{search.trim() ? "Try another name or a shorter search." : filter === "public" ? "Share a file from its menu to create a public link. You can revoke access at any time." : "A private space for photos, documents, and the files you share."}</EmptyDescription></EmptyHeader>
              <EmptyContent className="w-full max-w-none">{search.trim() ? <Button variant="outline" onClick={() => setSearch("")}>Clear search</Button> : filter === "public" ? <Button variant="outline" onClick={() => navigate("all")}>Browse all files</Button> : <button onClick={() => fileInput.current?.click()} className="mt-2 flex w-full flex-col gap-5 rounded-xl border bg-background p-4 text-left shadow-sm outline-none hover:border-muted-foreground/35 focus-visible:ring-2 focus-visible:ring-ring sm:p-5"><span className="text-[13px] text-muted-foreground">Drop files here, or click to choose files</span><span className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-xs text-muted-foreground"><LockKeyhole className="size-3" />Only your family, unless you share</span><span className="flex size-7 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"><ArrowUp className="size-4" /></span></span></button>}</EmptyContent>
            </Empty>}
          {data && data.items.length > 0 && <p className="mt-auto pt-10 text-center text-xs text-muted-foreground">Drop files anywhere to upload to {destination}.</p>}
        </div>
      </main>
    </div>
    <input ref={fileInput} type="file" multiple className="hidden" aria-label="Choose files to upload" onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) uploads.addFiles(files, folderId); event.target.value = ""; }} />
    <Dialog open={mobileNav} onOpenChange={setMobileNav}>
      <DialogContent className="h-[min(680px,90dvh)] sm:max-w-sm"><DialogHeader className="sr-only"><DialogTitle>Drive navigation</DialogTitle><DialogDescription>Browse your family’s shared files and manage your account.</DialogDescription></DialogHeader><DriveSidebar user={user} filter={filter} totalBytes={data?.totalBytes} totalFiles={data?.totalFiles} navigate={navigate} uploading={uploads.pending > 0} search={search} onSearch={setSearch} /></DialogContent>
    </Dialog>
    {dialog?.kind === "folder" && <DriveNameDialog parentId={folderId} onClose={() => setDialog(null)} />}
    {dialog?.kind === "rename" && <DriveNameDialog key={dialog.item.id} item={dialog.item} parentId={folderId} onClose={() => setDialog(null)} />}
    {dialog?.kind === "delete" && <DriveDeleteDialog item={dialog.item} onClose={() => setDialog(null)} />}
    {dialog?.kind === "share" && <DriveShareDialog key={dialog.item.id} item={dialog.item} onClose={() => setDialog(null)} />}
    {dialog?.kind === "preview" && <DrivePreviewDialog key={dialog.item.id} item={dialog.item} onClose={() => setDialog(null)} />}
    <DriveUploadQueue uploads={uploads} />
    {dragging && <div className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed border-primary bg-background/95 backdrop-blur-md" role="status"><div className="flex flex-col items-center gap-4 px-6 text-center"><span className="flex size-24 items-center justify-center rounded-3xl bg-primary/10"><CloudUpload className="size-12 text-primary" strokeWidth={1.4} /></span><p className="text-2xl font-semibold tracking-tight">Drop files to upload</p><p className="text-sm text-muted-foreground">Add to {destination}</p></div></div>}
  </div>;
}
