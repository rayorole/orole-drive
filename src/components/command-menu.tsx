"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock3, File, Files, Folder, Link2, Search, Star, Trash2 } from "lucide-react";
import { listDrive } from "@/app/actions/drive";
import type { DriveFilter, DriveItem } from "@/lib/drive-types";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/spinner";

type PaletteEntry =
  | { kind: "nav"; id: string; label: string; icon: typeof Files; filter: DriveFilter }
  | { kind: "item"; id: string; label: string; icon: typeof Files; item: DriveItem };

const navCommands: { id: string; label: string; icon: typeof Files; filter: DriveFilter }[] = [
  { id: "nav-all", label: "Go to All files", icon: Files, filter: "all" },
  { id: "nav-recent", label: "Go to Recent", icon: Clock3, filter: "recent" },
  { id: "nav-favorites", label: "Go to Favorites", icon: Star, filter: "favorites" },
  { id: "nav-public", label: "Go to Public links", icon: Link2, filter: "public" },
  { id: "nav-trash", label: "Go to Trash", icon: Trash2, filter: "trash" },
];

export function CommandMenu({ open, onOpenChange, onNavigate, onOpenItem }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (filter: DriveFilter, folderId?: string) => void;
  onOpenItem: (item: DriveItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const deferredQuery = useDeferredValue(query.trim());
  const inputRef = useRef<HTMLInputElement>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const [lastQuery, setLastQuery] = useState(deferredQuery);

  const search = useQuery({
    queryKey: ["drive-command-search", deferredQuery],
    queryFn: async () => {
      const result = await listDrive({ search: deferredQuery, sort: "name", direction: "asc" });
      return result.success ? result.data.items.slice(0, 8) : [];
    },
    enabled: deferredQuery.length > 0,
    staleTime: 15_000,
  });

  // Reset transient state during render (not in an effect) on the transitions that
  // require it, per React's "adjusting state when a prop changes" escape hatch.
  if (open && !wasOpen) {
    setWasOpen(true);
    setQuery("");
    setActiveIndex(0);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }
  if (deferredQuery !== lastQuery) {
    setLastQuery(deferredQuery);
    setActiveIndex(0);
  }
  useEffect(() => { if (open) requestAnimationFrame(() => inputRef.current?.focus()); }, [open]);

  const filteredNav = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? navCommands.filter((command) => command.label.toLowerCase().includes(needle)) : navCommands;
  }, [query]);

  const entries: PaletteEntry[] = useMemo(() => [
    ...filteredNav.map((command): PaletteEntry => ({ kind: "nav", id: command.id, label: command.label, icon: command.icon, filter: command.filter })),
    ...(search.data ?? []).map((item): PaletteEntry => ({ kind: "item", id: item.id, label: item.name, icon: item.kind === "folder" ? Folder : File, item })),
  ], [filteredNav, search.data]);

  function activate(entry: PaletteEntry) {
    onOpenChange(false);
    if (entry.kind === "nav") onNavigate(entry.filter);
    else onOpenItem(entry.item);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, entries.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); const entry = entries[activeIndex]; if (entry) activate(entry); }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="top-[18%] max-w-lg translate-y-0 gap-0 overflow-hidden p-0" showCloseButton={false}>
      <DialogHeader className="sr-only"><DialogTitle>Command menu</DialogTitle><DialogDescription>Search files and jump to a view.</DialogDescription></DialogHeader>
      <div className="relative border-b border-border/70">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Search files or jump to a view…" aria-label="Command menu search"
          role="combobox" aria-expanded aria-controls="command-menu-list" aria-activedescendant={entries[activeIndex]?.id}
          className="h-12 rounded-none border-0 pl-10 text-sm focus-visible:ring-0" autoComplete="off" />
      </div>
      <ul id="command-menu-list" role="listbox" aria-label="Command results" className="max-h-80 overflow-y-auto p-1.5">
        {deferredQuery && search.isFetching && <li className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Spinner size={12} />Searching…</li>}
        {entries.length === 0 && !(deferredQuery && search.isFetching) && <li className="px-3 py-6 text-center text-xs text-muted-foreground">No matches</li>}
        {entries.map((entry, index) => <li key={entry.id} id={entry.id} role="option" aria-selected={index === activeIndex}>
          <button type="button" onMouseEnter={() => setActiveIndex(index)} onClick={() => activate(entry)}
            className={cn("flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm outline-none", index === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground")}>
            <entry.icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.kind === "item" && <span className="shrink-0 text-[11px] text-muted-foreground">{entry.item.kind === "folder" ? "Folder" : "File"}</span>}
          </button>
        </li>)}
      </ul>
    </DialogContent>
  </Dialog>;
}
