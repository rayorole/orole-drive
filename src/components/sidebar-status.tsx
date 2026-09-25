"use client";

import { useQuery } from "@tanstack/react-query";
import { HardDrive, Plug, TriangleAlert } from "lucide-react";
import { getConnectedAgents } from "@/app/actions/mcp-status";
import { getStorageUsage } from "@/app/actions/storage-usage";
import type { StorageCategory, StorageQuota, StorageUsageReport } from "@/lib/drive-types";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format-bytes";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/hint";

export const CATEGORY_LABELS: Record<StorageCategory, string> = {
  image: "Images", video: "Videos", audio: "Audio", pdf: "PDFs", text: "Documents", code: "Code", archive: "Archives", other: "Other files",
};
export const SEGMENT_COLORS: Record<StorageCategory | "trash" | "versions" | "uploading", string> = {
  image: "bg-sky-500", video: "bg-violet-500", audio: "bg-pink-500", pdf: "bg-red-500", text: "bg-emerald-500", code: "bg-amber-500",
  archive: "bg-orange-700", other: "bg-slate-500", trash: "bg-stone-400", versions: "bg-indigo-300", uploading: "bg-teal-300",
};

/** Non-empty slices of the drive's usage (file types, Trash, old versions, uploads); they add up to `usedBytes`. */
export function usageParts(usage: StorageUsageReport) {
  return [
    ...usage.categories.map(({ category, bytes, files }) => ({ key: category, label: CATEGORY_LABELS[category], bytes, detail: `${files.toLocaleString()} ${files === 1 ? "file" : "files"}` })),
    { key: "trash" as const, label: "Trash", bytes: usage.trashBytes, detail: null },
    { key: "versions" as const, label: "Old versions", bytes: usage.versionBytes, detail: null },
    { key: "uploading" as const, label: "Uploads in progress", bytes: usage.uploadingBytes, detail: null },
  ].filter((part) => part.bytes > 0);
}

/** One colored slice per type, sized against the quota; the muted remainder is free space. */
export function UsageBar({ usage, total, className }: { usage: StorageUsageReport; total: number; className?: string }) {
  return <div className={cn("flex h-1.5 overflow-hidden rounded-full bg-foreground/15", className)} aria-hidden="true">
    {usageParts(usage).map((part) => <div key={part.key} className={cn("h-full shrink-0", SEGMENT_COLORS[part.key])} style={{ width: `${(part.bytes / total) * 100}%` }} />)}
  </div>;
}

/** Drive usage report. Keyed under "drive" so every drive mutation's invalidation refreshes it. */
export function useStorageUsage() {
  return useQuery({
    queryKey: ["drive", "storage-usage"],
    queryFn: async () => {
      const result = await getStorageUsage();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    staleTime: 30_000,
  });
}

/** Whole percent that only reads 100% once the limit is actually reached. */
export function usagePercent(used: number, quota: number) {
  return used >= quota ? 100 : Math.min(99, Math.round((used / quota) * 100));
}

// The fill carries severity; the unfilled track is a faint step of the same color, so meters read as one piece.
export function usageSeverity(ratio: number) {
  if (ratio >= 1) return { color: "var(--destructive)", level: "full" as const };
  if (ratio >= 0.9) return { color: "oklch(76.9% 0.188 70.08)", level: "low" as const }; // Tailwind amber-500
  return { color: "var(--primary)", level: null };
}

/** The most urgent of the drive's and the member's own limit, or null while both have room. */
function storageWarning(usage: StorageQuota) {
  const drive = usage.usedBytes / usage.quotaBytes;
  const member = usage.memberUsedBytes / usage.memberQuotaBytes;
  if (drive >= 1) return { ratio: drive, text: "Drive full" };
  if (member >= 1) return { ratio: member, text: "Your storage is full" };
  if (drive >= 0.9) return { ratio: drive, text: "Drive almost full" };
  if (member >= 0.9) return { ratio: member, text: "You’re almost at your limit" };
  return null;
}

export function StorageCard({ collapsed, onOpen }: { collapsed: boolean; onOpen: () => void }) {
  const { data: usage, isPending } = useStorageUsage();
  const percent = usage ? usagePercent(usage.usedBytes, usage.quotaBytes) : 0;
  const status = isPending ? "Checking usage…" : usage ? `${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)}` : "Usage unavailable";
  const warning = usage && storageWarning(usage);
  const summary = `${usage ? `${status} used (${percent}%)` : status}${warning ? `. ${warning.text}` : ""}`;
  const label = `Storage: ${summary}. Show storage details`;

  if (collapsed) return <div className="flex justify-center"><Hint label={summary} side="right">
    <button type="button" onClick={onOpen} aria-label={label} aria-haspopup="dialog" className="flex w-full flex-col items-center justify-center gap-1.5 px-3 py-3 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      <HardDrive className="size-4 text-muted-foreground" style={warning ? { color: usageSeverity(warning.ratio).color } : undefined} aria-hidden="true" />
      {usage && <UsageBar usage={usage} total={Math.max(usage.quotaBytes, usage.usedBytes)} className="h-1 w-6" />}
    </button>
  </Hint></div>;

  return <button type="button" onClick={onOpen} aria-label={label} aria-haspopup="dialog"
    className="flex w-full flex-col gap-2 px-3 py-3 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
    <span className="flex items-baseline justify-between gap-2 text-xs" aria-hidden="true">
      <span className="font-medium">Storage</span>
      <span className="truncate tabular-nums text-muted-foreground">{status}</span>
    </span>
    {usage ? <UsageBar usage={usage} total={Math.max(usage.quotaBytes, usage.usedBytes)} /> : <span className="h-1.5 rounded-full bg-foreground/15" aria-hidden="true" />}
    {warning
      ? <span className="flex items-center gap-1 text-[11px] font-medium" aria-hidden="true"><TriangleAlert className="size-3 shrink-0" style={{ color: usageSeverity(warning.ratio).color }} />{warning.text}</span>
      : usage && <span className="text-[11px] text-muted-foreground" aria-hidden="true">{usage.fileCount.toLocaleString()} {usage.fileCount === 1 ? "file" : "files"} · {percent}% used</span>}
  </button>;
}

export function useConnectedAgents() {
  return useQuery({
    queryKey: ["mcp-agents"],
    queryFn: async () => {
      const result = await getConnectedAgents();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

/** Header trigger for the MCP dialog; once an assistant is connected it shows the count with a live green dot. */
export function AgentConnectButton({ onConnect }: { onConnect: () => void }) {
  const agents = useConnectedAgents().data;
  const count = agents?.count ?? 0;
  const label = count ? `${count} ${count === 1 ? "Agent" : "Agents"} connected` : "Connect MCP";
  const title = count ? `${label}: ${agents!.names.join(", ")}` : "Connect an AI assistant with MCP";
  return <Hint label={title}><Button variant="outline" size="sm" aria-label={label} onClick={onConnect}>
    {count > 0
      ? <span className="relative flex size-2 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex size-full rounded-full bg-emerald-500 opacity-60 motion-safe:animate-ping [animation-duration:2.5s]" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      : <Plug data-icon="inline-start" />}
    <span className="max-sm:sr-only">{label}</span>
  </Button></Hint>;
}
