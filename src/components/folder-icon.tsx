import { Folder } from "lucide-react";
import { cn } from "@/lib/utils";

const folderColors: Record<string, string> = {
  blue: "text-blue-500 fill-blue-500/20", green: "text-green-500 fill-green-500/20", amber: "text-amber-500 fill-amber-500/20",
  red: "text-red-500 fill-red-500/20", violet: "text-violet-500 fill-violet-500/20", gray: "text-gray-500 fill-gray-500/20",
};

export function FolderIcon({ item, large = false, compact = false }: {
  item: { folderColor?: string | null; folderEmoji?: string | null };
  large?: boolean;
  compact?: boolean;
}) {
  const tint = item.folderColor ? folderColors[item.folderColor] : undefined;
  return <span aria-hidden="true" className={cn("relative inline-flex shrink-0 items-center justify-center", large ? "size-20" : compact ? "size-5" : "size-8 rounded-lg bg-muted/65")}>
    <Folder className={cn(large ? "size-[4.5rem]" : "size-5", tint ?? "fill-primary/20 text-primary")} strokeWidth={large ? 1.2 : 1.6} />
    {item.folderEmoji && <span className={cn("absolute leading-none", large ? "bottom-3 right-1 text-3xl" : "-bottom-0.5 -right-0.5 text-sm")}>{item.folderEmoji}</span>}
  </span>;
}
