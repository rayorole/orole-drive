"use client";

import {
  Archive, Code2, Download, File, FileImage, FileMusic, FileText,
  FileVideo, Folder, Link2, MoreHorizontal, Pencil, Trash2,
} from "lucide-react";
import type { DriveItem } from "@/lib/drive-types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
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
  item: Pick<DriveItem, "name" | "kind" | "mimeType">;
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
  return (
    <span aria-hidden="true" className={cn(
      "inline-flex shrink-0 items-center justify-center",
      large ? "size-20" : "size-8 rounded-lg bg-muted/65",
      item.kind === "folder" || mime.startsWith("image/") ? "text-primary" : "text-muted-foreground",
    )}>
      <Icon className={cn(large ? "size-[4.5rem]" : "size-5", item.kind === "folder" && "fill-primary/20")} strokeWidth={large ? 1.2 : 1.6} />
    </span>
  );
}

export type DriveItemAction = "rename" | "delete" | "share" | "download";

function ItemMenu({ item, onAction }: { item: DriveItem; onAction: (action: DriveItemAction, item: DriveItem) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`Actions for ${item.name}`} />}>
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onAction("rename", item)}><Pencil />Rename</DropdownMenuItem>
          {item.kind === "file" && <>
            <DropdownMenuItem onClick={() => onAction("download", item)}><Download />Download</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAction("share", item)}><Link2 />{item.publicToken ? "Manage public link" : "Share file"}</DropdownMenuItem>
          </>}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onClick={() => onAction("delete", item)}><Trash2 />Delete</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DriveItems({ items, view, onOpen, onAction }: {
  items: DriveItem[];
  view: "grid" | "list";
  onOpen: (item: DriveItem) => void;
  onAction: (action: DriveItemAction, item: DriveItem) => void;
}) {
  const date = (value: string) => new Date(value).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
  if (view === "grid") return (
    <ul aria-label="Files and folders" className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 2xl:grid-cols-5">
      {items.map((item) => <li key={item.id} className="group relative min-w-0 rounded-xl border border-border/70 bg-card transition-shadow hover:shadow-sm">
        <div className="absolute right-2 top-2"><ItemMenu item={item} onAction={onAction} /></div>
        <button onClick={() => onOpen(item)} className="flex w-full min-w-0 flex-col items-center rounded-xl px-3 pb-4 pt-6 text-center outline-none hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:bg-accent/60 motion-safe:transition-colors">
          <DriveFileIcon item={item} large />
          <span className="mt-3 flex w-full min-w-0 items-center justify-center gap-1.5">
            <span className="truncate text-[13px] font-medium" title={item.name}>{item.name}</span>
            {item.publicToken && <Link2 aria-label="Public link enabled" className="size-3.5 shrink-0 text-primary" />}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">{item.kind === "folder" ? "Folder" : formatBytes(item.size)}</span>
          <span className="mt-1 text-[11px] text-muted-foreground">{date(item.updatedAt)}</span>
        </button>
      </li>)}
    </ul>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-left text-[13px]">
        <caption className="sr-only">Files and folders</caption>
        <thead>
          <tr className="border-b border-border/70 text-xs text-muted-foreground">
            <th scope="col" className="pb-3 pl-3 font-medium">Name</th>
            <th scope="col" className="hidden w-36 pb-3 font-medium md:table-cell">Date modified</th>
            <th scope="col" className="hidden w-28 pb-3 font-medium xl:table-cell">Kind</th>
            <th scope="col" className="w-24 pb-3 pr-3 text-right font-medium">Size</th>
            <th scope="col" className="w-12 pb-3"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => <tr key={item.id} className="group border-b border-border/45 last:border-0 hover:bg-accent/40 focus-within:bg-accent/40 active:bg-accent/60">
            <td className="p-0">
              <button onClick={() => onOpen(item)} className="flex w-full min-w-0 items-center gap-3 rounded-lg bg-transparent py-2.5 pl-3 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <DriveFileIcon item={item} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium" title={item.name}>{item.name}</span>
                    {item.publicToken && <Link2 aria-label="Public link enabled" className="size-3.5 shrink-0 text-primary" />}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground md:hidden">{date(item.updatedAt)}</span>
                </span>
              </button>
            </td>
            <td className="hidden text-xs text-muted-foreground md:table-cell"><time dateTime={item.updatedAt}>{date(item.updatedAt)}</time></td>
            <td className="hidden truncate pr-2 text-xs text-muted-foreground xl:table-cell">{fileType(item)}</td>
            <td className="pr-3 text-right text-xs tabular-nums text-muted-foreground">{item.kind === "folder" ? "—" : formatBytes(item.size)}</td>
            <td className="pr-2"><ItemMenu item={item} onAction={onAction} /></td>
          </tr>)}
        </tbody>
      </table>
    </div>
  );
}
