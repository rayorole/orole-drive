"use client";

import { useQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import {
  ArrowUp, Clock3, Download, File, Files, Folder, FolderInput, FolderPlus, FolderUp, HardDrive, LayoutGrid, Link2,
  History, List, Moon, PanelLeft, Plug, Search, Star, StarOff, Sun, Trash2,
} from "lucide-react";
import { listDrive } from "@/app/actions/drive";
import type { DriveFilter, DriveItem } from "@/lib/drive-types";
import { canEditItem } from "@/lib/drive-permissions";
import type { DriveItemAction } from "@/components/drive-item";
import { CommandMenu, type CommandMenuAction } from "@/components/ui/command-menu";

const views: { filter: DriveFilter | "activity"; label: string; icon: typeof Files; keywords: string[] }[] = [
  { filter: "all", label: "All files", icon: Files, keywords: ["home", "root", "drive"] },
  { filter: "recent", label: "Recent", icon: Clock3, keywords: ["latest", "opened", "history"] },
  { filter: "favorites", label: "Favorites", icon: Star, keywords: ["starred"] },
  { filter: "public", label: "Public links", icon: Link2, keywords: ["shared", "share"] },
  { filter: "activity", label: "Activity", icon: History, keywords: ["history", "log", "changes", "who", "timeline"] },
  { filter: "trash", label: "Trash", icon: Trash2, keywords: ["deleted", "bin", "restore"] },
];

function itemAction(item: DriveItem, prefix: string, onOpenItem: (item: DriveItem) => void, group?: string): CommandMenuAction {
  const Icon = item.kind === "folder" ? Folder : File;
  return {
    id: `${prefix}-${item.id}`, label: item.name, group, icon: <Icon />,
    hint: item.kind === "folder" ? "Folder" : undefined, keywords: item.tags,
    action: () => onOpenItem(item),
  };
}

export function DriveCommandMenu({ filter, items, selected, canUpload, view, collapsed, onNavigate, onOpenItem, onItemAction, onUploadFiles, onUploadFolder, onNewFolder, onViewChange, onToggleSidebar, onConnectAgent, onOpenStorage, onEmptyTrash }: {
  filter: DriveFilter | "activity";
  items: DriveItem[];
  selected: DriveItem[];
  canUpload: boolean;
  view: "grid" | "list";
  collapsed: boolean;
  onNavigate: (filter: DriveFilter | "activity") => void;
  onOpenItem: (item: DriveItem) => void;
  onItemAction: (action: DriveItemAction, items: DriveItem[]) => void;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
  onNewFolder: () => void;
  onViewChange: (view: "grid" | "list") => void;
  onToggleSidebar: () => void;
  onConnectAgent: () => void;
  onOpenStorage: () => void;
  onEmptyTrash: () => void;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const recent = useQuery({
    queryKey: ["command-recent"],
    queryFn: async () => {
      const result = await listDrive({ filter: "recent" });
      return result.success ? result.data.items.slice(0, 30) : [];
    },
    staleTime: 60_000,
  });
  const recentFiles = recent.data ?? [];
  const selection = `${selected.length} selected`;
  const allFavorites = selected.length > 0 && selected.every((item) => item.isFavorite);
  const dark = resolvedTheme === "dark";

  const actions: CommandMenuAction[] = [
    ...(selected.length && filter !== "trash" ? [
      { id: "sel-download", group: selection, label: selected.length === 1 && selected[0].kind === "file" ? "Download" : "Download ZIP", icon: <Download />, action: () => onItemAction("download", selected) },
      { id: "sel-move", group: selection, label: "Move to…", icon: <FolderInput />, disabled: !selected.every(canEditItem), action: () => onItemAction("move", selected) },
      { id: "sel-favorite", group: selection, label: allFavorites ? "Remove from favorites" : "Add to favorites", icon: allFavorites ? <StarOff /> : <Star />, action: () => onItemAction(allFavorites ? "unfavorite" : "favorite", selected) },
      { id: "sel-trash", group: selection, label: "Move to Trash", icon: <Trash2 />, disabled: !selected.every(canEditItem), action: () => onItemAction("trash", selected) },
    ] : []),
    ...views.map(({ filter: target, label, icon: Icon, keywords }) => ({
      id: `go-${target}`, group: "Go to", label, keywords, icon: <Icon />,
      hint: target === filter ? "Current" : undefined,
      action: () => onNavigate(target),
    })),
    {
      id: "open-recent", group: "Go to", label: "Open a recent file", crumb: "Recent files", icon: <Clock3 />,
      keywords: ["recent", "open"], disabled: recentFiles.length === 0,
      children: recentFiles.map((item) => itemAction(item, "recent", onOpenItem)),
    },
    {
      id: "search-files", group: "Go to", label: "Search all files", icon: <Search />, shortcut: ["/"],
      action: () => { requestAnimationFrame(() => document.getElementById("drive-global-search")?.focus()); },
    },
    { id: "upload-files", group: "Add", label: "Upload files", icon: <ArrowUp />, disabled: !canUpload, keywords: ["add", "import"], action: onUploadFiles },
    { id: "upload-folder", group: "Add", label: "Upload folder", icon: <FolderUp />, disabled: !canUpload, keywords: ["add", "directory"], action: onUploadFolder },
    { id: "new-folder", group: "Add", label: "New folder", icon: <FolderPlus />, disabled: !canUpload, keywords: ["create", "directory"], action: onNewFolder },
    { id: "empty-trash", group: "Trash", label: "Empty Trash…", icon: <Trash2 />, disabled: filter !== "trash" || !items.some(canEditItem), keywords: ["delete", "permanently", "bin", "clear", "free space"], action: onEmptyTrash },
    { id: "view", group: "View", label: view === "list" ? "Show as grid" : "Show as list", icon: view === "list" ? <LayoutGrid /> : <List />, keywords: ["layout", "grid", "list"], action: () => onViewChange(view === "list" ? "grid" : "list") },
    { id: "sidebar", group: "View", label: collapsed ? "Expand sidebar" : "Collapse sidebar", icon: <PanelLeft />, keywords: ["navigation"], action: onToggleSidebar },
    { id: "theme", group: "View", label: dark ? "Switch to light theme" : "Switch to dark theme", icon: dark ? <Sun /> : <Moon />, keywords: ["appearance", "dark", "light", "mode"], action: () => setTheme(dark ? "light" : "dark") },
    { id: "agent", group: "View", label: "Connect an agent", icon: <Plug />, keywords: ["mcp", "ai", "assistant", "claude"], action: onConnectAgent },
    { id: "storage", group: "View", label: "Storage usage", icon: <HardDrive />, keywords: ["space", "quota", "disk", "size", "largest", "full", "free"], action: onOpenStorage },
    // Listed only while typing, so the home level stays short.
    ...items.map((item) => ({ ...itemAction(item, "here", onOpenItem, "In this view"), hidden: true })),
    ...recentFiles.filter((item) => !items.some((here) => here.id === item.id)).map((item) => ({ ...itemAction(item, "recent-search", onOpenItem, "Recent files"), hidden: true })),
  ];

  return <CommandMenu actions={actions} placeholder="Search files, views and actions…" />;
}
