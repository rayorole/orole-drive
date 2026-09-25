"use client";

import { Fragment, type MouseEvent, type ReactElement, type ReactNode } from "react";
import {
  Archive, ArrowUp, Code2, Download, File, FileImage, FileMusic, FileText,
  FileVideo, Folder, FolderCog, FolderInput, FolderPlus, FolderUp, Info, KeyRound, Link2, LockKeyhole,
  MoreHorizontal, Pencil, Plus, RotateCcw, ShieldAlert, ShieldCheck, Star, Trash2, UnlockKeyhole,
} from "lucide-react";
import type { DriveItem } from "@/lib/drive-types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DriveThumbnail } from "@/components/drive-thumbnail";
import { ScanningIndicator } from "@/components/file-scan-badge";
import { useDriveItemDnd } from "@/components/drive-drag";
import {
  ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem,
  ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent,
  ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/cubby-ui/context-menu";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function formatBytes(bytes: number) {
  if (bytes === 0) return "0 bytes";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: unit > 0 ? 1 : 0 }).format(bytes / 1024 ** unit)} ${units[unit]}`;
}

export function fileType(item: Pick<DriveItem, "name" | "kind" | "mimeType">) {
  if (item.kind === "folder") return "Folder";
  const extension = item.name.split(".").pop();
  return extension && extension !== item.name ? `${extension.toUpperCase()} file` : "File";
}

export function DriveFileIcon({ item, large = false }: {
  item: Pick<DriveItem, "name" | "kind" | "mimeType"> & { folderColor?: string | null };
  large?: boolean;
}) {
  const mime = item.mimeType ?? "";
  const Icon = item.kind === "folder" ? Folder
    : mime.startsWith("image/") ? FileImage
    : mime.startsWith("video/") ? FileVideo
    : mime.startsWith("audio/") ? FileMusic
    : /zip|compressed|archive|tar/.test(mime) ? Archive
    : /json|javascript|xml|html/.test(mime) ? Code2
    : mime.startsWith("text/") || mime === "application/pdf" ? FileText : File;
  const folderColorClass: Record<string, string> = {
    blue: "text-blue-500 fill-blue-500/20", green: "text-green-500 fill-green-500/20", amber: "text-amber-500 fill-amber-500/20",
    red: "text-red-500 fill-red-500/20", violet: "text-violet-500 fill-violet-500/20", gray: "text-gray-500 fill-gray-500/20",
  };
  const tint = item.kind === "folder" && item.folderColor ? folderColorClass[item.folderColor] : undefined;
  return (
    <span aria-hidden="true" className={cn(
      "inline-flex shrink-0 items-center justify-center",
      large ? "size-20" : "size-8 rounded-lg bg-muted/65",
      tint ? tint.split(" ")[0] : (item.kind === "folder" || mime.startsWith("image/") ? "text-primary" : "text-muted-foreground"),
    )}>
      <Icon className={cn(large ? "size-[4.5rem]" : "size-5", item.kind === "folder" && (tint ? tint.split(" ")[1] : "fill-primary/20"))} strokeWidth={large ? 1.2 : 1.6} />
    </span>
  );
}

export type DriveItemAction = "open" | "rename" | "trash" | "permanent" | "restore" | "share" | "download" | "move" | "password" | "lock" | "upload-files" | "upload-folder" | "new-folder" | "details" | "scan";
type ItemActionHandler = (action: DriveItemAction, items: DriveItem[]) => void;
type MenuEntry = { action: DriveItemAction; label: string; icon: typeof Folder; destructive?: boolean; disabled?: boolean };

type MenuSubmenu = { submenu: string; icon: typeof Folder; entries: MenuEntry[] };
type MenuNode = MenuEntry | MenuSubmenu;

// A submenu with a single entry is shown inline, and an empty one is dropped.
function submenu(label: string, icon: typeof Folder, entries: MenuEntry[]): MenuNode[] {
  return entries.length > 1 ? [{ submenu: label, icon, entries }] : entries;
}

function scanEntry(file: DriveItem): MenuEntry {
  if (file.scanStatus === "scanning") return { action: "scan", label: "Scanning for viruses…", icon: ShieldCheck, disabled: true };
  if (file.scanStatus) return { action: "details", label: "View scan result", icon: file.scanStatus === "clean" ? ShieldCheck : ShieldAlert };
  return { action: "scan", label: "Scan for viruses", icon: ShieldCheck };
}

// Sections are separated by a divider; destructive actions always sit alone at the bottom.
function itemMenu(items: DriveItem[], trash: boolean): MenuNode[][] {
  const single = items.length === 1 ? items[0] : null;
  if (trash) return [
    [
      ...(single?.kind === "folder" ? [{ action: "open" as const, label: "Browse folder", icon: Folder }] : []),
      { action: "restore", label: "Restore", icon: RotateCcw },
    ],
    [{ action: "permanent", label: "Delete permanently", icon: Trash2, destructive: true }],
  ];
  const folder = single?.kind === "folder" ? single : null;
  const sections: MenuNode[][] = [
    [
      ...(single ? [{ action: "open" as const, label: single.isLocked ? "Unlock folder" : folder ? "Open folder" : "Preview", icon: single.isLocked ? UnlockKeyhole : folder ? Folder : File }] : []),
      { action: "download", label: single?.kind === "file" ? "Download" : "Download ZIP", icon: Download },
      ...(single?.kind === "file" ? [{ action: "share" as const, label: single.publicToken ? "Manage public link" : single.isProtected ? "Protected — no public links" : "Share file", icon: Link2, disabled: single.isProtected }] : []),
      ...(single?.kind === "file" ? [scanEntry(single)] : []),
    ],
    [
      ...(folder ? submenu("Add to folder", Plus, [
        { action: "upload-files", label: "Upload files", icon: ArrowUp },
        { action: "upload-folder", label: "Upload folder", icon: FolderUp },
        { action: "new-folder", label: "New folder", icon: FolderPlus },
      ]) : []),
      ...submenu("Organize", FolderCog, [
        { action: "move", label: "Move to…", icon: FolderInput },
        ...(single ? [{ action: "rename" as const, label: "Rename", icon: Pencil }] : []),
        ...(single ? [{ action: "details" as const, label: "Details & tags", icon: Info }] : []),
      ]),
      ...(folder ? submenu("Security", ShieldCheck, [
        { action: "password", label: folder.hasPassword ? "Manage password" : "Protect with password", icon: KeyRound },
        ...(folder.hasPassword && !folder.isLocked ? [{ action: "lock" as const, label: "Lock folder", icon: LockKeyhole }] : []),
      ]) : []),
    ],
    [{ action: "trash", label: "Move to Trash", icon: Trash2, destructive: true }],
  ];
  return sections.filter((section) => section.length > 0);
}

function ItemMenu({ item, targets, trash, disabled, onAction }: { item: DriveItem; targets: DriveItem[]; trash: boolean; disabled: boolean; onAction: ItemActionHandler }) {
  const entry = ({ action, label, icon: Icon, destructive, disabled: unavailable }: MenuEntry) =>
    <DropdownMenuItem key={action} disabled={unavailable} variant={destructive ? "destructive" : "default"} onClick={() => onAction(action, targets)}><Icon />{label}</DropdownMenuItem>;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon" disabled={disabled} aria-label={targets.length > 1 ? `Actions for ${targets.length} selected items` : `Actions for ${item.name}`} />}><MoreHorizontal /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-52">
      {itemMenu(targets, trash).map((section, index) => <Fragment key={index}>
        {index > 0 && <DropdownMenuSeparator />}
        <DropdownMenuGroup>{section.map((node) => "submenu" in node
          ? <DropdownMenuSub key={node.submenu}>
            <DropdownMenuSubTrigger><node.icon />{node.submenu}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">{node.entries.map(entry)}</DropdownMenuSubContent>
          </DropdownMenuSub>
          : entry(node))}</DropdownMenuGroup>
      </Fragment>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function ItemContext({ render, children, targets, trash, disabled, onAction }: { render: ReactElement; children: ReactNode; targets: DriveItem[]; trash: boolean; disabled: boolean; onAction: ItemActionHandler }) {
  const entry = ({ action, label, icon: Icon, destructive, disabled: unavailable }: MenuEntry) =>
    <ContextMenuItem key={action} disabled={disabled || unavailable} variant={destructive ? "destructive" : "default"} onClick={() => onAction(action, targets)}><Icon />{label}</ContextMenuItem>;
  return <ContextMenu>
    <ContextMenuTrigger render={render} onContextMenu={(event) => event.stopPropagation()}>{children}</ContextMenuTrigger>
    <ContextMenuContent className="w-52">
      {targets.length > 1 && <><ContextMenuLabel>{targets.length} selected items</ContextMenuLabel><ContextMenuSeparator /></>}
      {itemMenu(targets, trash).map((section, index) => <Fragment key={index}>
        {index > 0 && <ContextMenuSeparator />}
        <ContextMenuGroup>{section.map((node) => "submenu" in node
          ? <ContextMenuSub key={node.submenu}>
            <ContextMenuSubTrigger disabled={disabled} className="gap-2 [&>svg:first-child]:size-4 [&>svg:first-child]:text-muted-foreground"><node.icon />{node.submenu}</ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-48">{node.entries.map(entry)}</ContextMenuSubContent>
          </ContextMenuSub>
          : entry(node))}</ContextMenuGroup>
      </Fragment>)}
    </ContextMenuContent>
  </ContextMenu>;
}

function ItemStatus({ item }: { item: DriveItem }) {
  return <>{item.isFavorite && <Star aria-label="Favorited" className="size-3.5 shrink-0 fill-amber-400 text-amber-400" />}{item.isProtected && <LockKeyhole aria-label={item.isLocked ? "Locked folder" : "Password protected"} className="size-3.5 shrink-0 text-muted-foreground" />}{item.publicToken && <Link2 aria-label="Public link enabled" className="size-3.5 shrink-0 text-primary" />}{item.scanStatus === "scanning" && <ScanningIndicator itemId={item.id} />}{(item.scanStatus === "suspicious" || item.scanStatus === "malicious") && <ShieldAlert aria-label={item.scanStatus === "malicious" ? "Flagged as malicious" : "Flagged as suspicious"} className="size-3.5 shrink-0 text-destructive" />}</>;
}

// Hooks can't run inside the list's map, so each row gets this small wrapper.
function ItemDnd({ item, enabled, dragIds, children }: { item: DriveItem; enabled: boolean; dragIds: (id: string) => string[]; children: (dnd: ReturnType<typeof useDriveItemDnd>) => ReactElement }) {
  return children(useDriveItemDnd(item, { enabled, dragIds }));
}

export function DriveItems({ items, view, selected, trash = false, disabled = false, onSelect, onOpen, onOpenIntent, onAction, draggable = false }: {
  items: DriveItem[];
  view: "grid" | "list";
  selected: ReadonlySet<string>;
  trash?: boolean;
  disabled?: boolean;
  onSelect: (id: string, range: boolean) => void;
  onOpen: (item: DriveItem) => void;
  onOpenIntent: (item: DriveItem) => void;
  onAction: ItemActionHandler;
  /** Enables dragging items onto folders; needs a DriveDndProvider above. */
  draggable?: boolean;
}) {
  const date = (value: string) => new Date(value).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
  const selectedItems = items.filter((item) => selected.has(item.id));
  const targetsFor = (item: DriveItem) => selected.has(item.id) ? selectedItems : [item];
  // Dragging a selected item carries the whole selection; unlocked folders accept drops.
  const dnd = { enabled: draggable && !trash && !disabled, dragIds: (id: string) => selected.has(id) ? selectedItems.map((item) => item.id) : [id] };
  function activate(event: MouseEvent<HTMLButtonElement>, item: DriveItem) {
    if (event.shiftKey || event.ctrlKey || event.metaKey) onSelect(item.id, event.shiftKey);
    else onOpen(item);
  }
  const checkbox = (item: DriveItem) => <Checkbox checked={selected.has(item.id)} disabled={disabled} aria-label={`Select ${item.name}`} onCheckedChange={(_checked, details) => onSelect(item.id, "shiftKey" in details.event && Boolean(details.event.shiftKey))} />;
  if (view === "grid") return (
    <ul aria-label={trash ? "Trashed files and folders" : "Files and folders"} className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 2xl:grid-cols-5">
      {items.map((item) => <ItemDnd key={item.id} item={item} {...dnd}>{({ ref, dragListeners, isDragged, isOver }) => <ItemContext targets={targetsFor(item)} trash={trash} disabled={disabled} onAction={onAction} render={<li ref={ref} {...dragListeners} data-drive-item={item.id} className={cn("group relative min-w-0 rounded-xl border border-border/70 bg-card hover:bg-accent/40 focus-within:bg-accent/40", selected.has(item.id) && "border-ring/60 bg-accent/50", isDragged && "opacity-50", isOver && "bg-primary/10 ring-2 ring-primary/60")} />}>
        <div className="absolute left-3 top-4">{checkbox(item)}</div>
        <div className="absolute right-1 top-1"><ItemMenu item={item} targets={targetsFor(item)} trash={trash} disabled={disabled} onAction={onAction} /></div>
        <button disabled={disabled || (trash && item.kind === "file")} onClick={(event) => activate(event, item)} onMouseEnter={() => onOpenIntent(item)} onFocus={() => onOpenIntent(item)} className="flex w-full min-w-0 flex-col items-center rounded-xl px-3 pb-4 pt-11 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default">
          <span className="flex h-24 w-full items-center justify-center overflow-hidden rounded-lg">{trash ? <DriveFileIcon item={item} large /> : <DriveThumbnail item={item} fallback={<DriveFileIcon item={item} large />} />}</span>
          <span className="mt-3 flex w-full min-w-0 items-center justify-center gap-1.5"><span className="truncate text-[13px] font-medium" title={item.name}>{item.name}</span><ItemStatus item={item} /></span>
          <span className="mt-1 text-xs text-muted-foreground">{item.kind === "folder" ? "Folder" : formatBytes(item.size)}</span>
          <span className="mt-1 text-[11px] text-muted-foreground">{date(trash && item.trashedAt ? item.trashedAt : item.updatedAt)}</span>
        </button>
      </ItemContext>}</ItemDnd>)}
    </ul>
  );
  return <div className="overflow-x-auto">
    <table className="w-full table-fixed text-left text-[13px]">
      <caption className="sr-only">{trash ? "Trashed files and folders" : "Files and folders"}</caption>
      <thead><tr className="border-b border-border/70 text-xs text-muted-foreground">
        <th scope="col" className="w-9"><span className="sr-only">Select</span></th>
        <th scope="col" className="pb-3 pl-1 font-medium">Name</th>
        <th scope="col" className="hidden w-36 pb-3 font-medium md:table-cell">{trash ? "Date trashed" : "Date modified"}</th>
        <th scope="col" className="hidden w-28 pb-3 font-medium xl:table-cell">Kind</th>
        <th scope="col" className="hidden w-24 pb-3 pr-3 text-right font-medium sm:table-cell">Size</th>
        <th scope="col" className="w-10 pb-3"><span className="sr-only">Actions</span></th>
      </tr></thead>
      <tbody>{items.map((item) => <ItemDnd key={item.id} item={item} {...dnd}>{({ ref, dragListeners, isDragged, isOver }) => <ItemContext targets={targetsFor(item)} trash={trash} disabled={disabled} onAction={onAction} render={<tr ref={ref} {...dragListeners} data-drive-item={item.id} className={cn("group border-b border-border/45 last:border-0 hover:bg-accent/40 focus-within:bg-accent/40 active:bg-accent/60", selected.has(item.id) && "bg-accent/50", isDragged && "opacity-50", isOver && "bg-primary/10 ring-2 ring-inset ring-primary/60")} />}>
        <td className="pl-2">{checkbox(item)}</td>
        <td className="p-0"><button disabled={disabled || (trash && item.kind === "file")} onClick={(event) => activate(event, item)} onMouseEnter={() => onOpenIntent(item)} onFocus={() => onOpenIntent(item)} className="flex w-full min-w-0 items-center gap-2 rounded-lg bg-transparent py-2.5 pl-1 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default">
          <DriveFileIcon item={item} /><span className="min-w-0"><span className="flex items-center gap-1.5"><span className="truncate font-medium" title={item.name}>{item.name}</span><ItemStatus item={item} /></span><span className="mt-0.5 block truncate text-xs text-muted-foreground md:hidden">{date(trash && item.trashedAt ? item.trashedAt : item.updatedAt)}{item.kind === "file" && <span className="sm:hidden"> · {formatBytes(item.size)}</span>}</span></span>
        </button></td>
        <td className="hidden text-xs text-muted-foreground md:table-cell"><time dateTime={trash && item.trashedAt ? item.trashedAt : item.updatedAt}>{date(trash && item.trashedAt ? item.trashedAt : item.updatedAt)}</time></td>
        <td className="hidden truncate pr-2 text-xs text-muted-foreground xl:table-cell">{fileType(item)}</td>
        <td className="hidden pr-3 text-right text-xs tabular-nums text-muted-foreground sm:table-cell">{item.kind === "folder" ? "—" : formatBytes(item.size)}</td>
        <td><ItemMenu item={item} targets={targetsFor(item)} trash={trash} disabled={disabled} onAction={onAction} /></td>
      </ItemContext>}</ItemDnd>)}</tbody>
    </table>
  </div>;
}
