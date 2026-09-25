"use client";

import type { ReactNode } from "react";
import { ChevronRight, Info, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import type { DriveFilter, StorageUsageReport } from "@/lib/drive-types";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format-bytes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/spinner";
import { DriveFileIcon } from "@/components/drive-item";
import { Hint, TruncatedText } from "@/components/hint";
import { SEGMENT_COLORS, usageParts, usagePercent, usageSeverity, useStorageUsage } from "@/components/sidebar-status";

// SVG strokes need their own literal classes; these mirror SEGMENT_COLORS.
const STROKE_COLORS: Record<keyof typeof SEGMENT_COLORS, string> = {
  image: "stroke-sky-500", video: "stroke-violet-500", audio: "stroke-pink-500", pdf: "stroke-red-500", text: "stroke-emerald-500", code: "stroke-amber-500",
  archive: "stroke-orange-700", other: "stroke-slate-500", trash: "stroke-stone-400", versions: "stroke-indigo-300", uploading: "stroke-teal-300",
};

/** Ring of what's using space. The circle's circumference is 100, so dash lengths are percentages. */
function UsageDonut({ usage }: { usage: StorageUsageReport }) {
  const parts = usageParts(usage);
  const gap = parts.length > 1 ? 1.5 : 0;
  const lengths = parts.map((part) => Math.max((part.bytes / usage.usedBytes) * 100 - gap, 0.5));
  const offsets = lengths.map((_, index) => lengths.slice(0, index).reduce((sum, length) => sum + length + gap, 0));
  return <div className="relative size-32 shrink-0">
    <svg viewBox="0 0 36 36" className="size-full -rotate-90" aria-hidden="true">
      <circle cx="18" cy="18" r="15.9155" fill="none" strokeWidth="3.5" className="stroke-muted" />
      {parts.map((part, index) => <circle key={part.key} cx="18" cy="18" r="15.9155" fill="none" strokeWidth="3.5"
        strokeDasharray={`${lengths[index]} ${100 - lengths[index]}`} strokeDashoffset={-offsets[index]} className={STROKE_COLORS[part.key]} />)}
    </svg>
    <div className="absolute inset-0 flex flex-col items-center justify-center">
      <span className="text-base font-semibold tabular-nums">{formatBytes(usage.usedBytes)}</span>
      <span className="text-xs text-muted-foreground">used</span>
    </div>
  </div>;
}

function UsageMeter({ label, name, used, quota }: { label: string; name: string; used: number; quota: number }) {
  const ratio = used / quota;
  const percent = usagePercent(used, quota);
  const { color, level } = usageSeverity(ratio);
  const text = `${formatBytes(used)} of ${formatBytes(quota)}`;
  return <div className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-muted/50 p-3">
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{percent}%</span>
    </div>
    <div role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${text} (${percent}%)`}
      className="h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)` }}>
      <div className="h-full rounded-full" style={{ width: `${Math.min(ratio, 1) * 100}%`, backgroundColor: color }} />
    </div>
    <span className="truncate text-xs tabular-nums text-muted-foreground">{text}</span>
    {level && <p className="flex items-center gap-1 text-xs font-medium"><TriangleAlert className="size-3.5 shrink-0" style={{ color }} aria-hidden="true" />
      {level === "full" ? "Limit reached" : "Almost full"}</p>}
  </div>;
}

/** Collapsed by default, so the dialog opens on the overview only. */
function Disclosure({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <details className="group rounded-lg border border-border/70">
    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
      <span className="flex-1">{title}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
    </summary>
    <div className="px-3 pb-3">{children}</div>
  </details>;
}

function UsageDetails({ usage, onNavigate }: { usage: StorageUsageReport; onNavigate: (filter: DriveFilter, folderId?: string) => void }) {
  const parts = usageParts(usage);
  const largestMember = Math.max(1, ...usage.members.map((member) => member.bytes));

  return <div className="flex flex-col gap-5">
    {parts.length ? <div className="flex items-center gap-5">
      <UsageDonut usage={usage} />
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5" aria-label="What’s using space">
        {parts.map((part) => <li key={part.key} className="flex items-center gap-2 text-sm">
          <span className={cn("size-2 shrink-0 rounded-full", SEGMENT_COLORS[part.key])} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{part.label}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(part.bytes)}</span>
        </li>)}
      </ul>
    </div> : <p className="py-6 text-center text-sm text-muted-foreground">No accessible storage.</p>}

    <div className="grid grid-cols-2 gap-2">
      <UsageMeter label="Drive" name="Accessible storage against drive limit" used={usage.usedBytes} quota={usage.quotaBytes} />
      <UsageMeter label="Your uploads" name="Your accessible uploads against member limit" used={usage.memberUsedBytes} quota={usage.memberQuotaBytes} />
    </div>

    {(usage.trashBytes > 0 || usage.versionBytes > 0) && <div className="flex flex-col gap-2">
      {usage.trashBytes > 0 && <div className="flex items-center gap-3 rounded-lg border border-border/70 py-1.5 pl-3 pr-1.5 text-sm">
        <Trash2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">Trash <span className="tabular-nums text-muted-foreground">· {formatBytes(usage.trashBytes)}</span></span>
        <Button variant="ghost" size="sm" onClick={() => onNavigate("trash")}>Open Trash</Button>
      </div>}
      {usage.versionBytes > 0 && <div className="flex items-center gap-3 rounded-lg border border-border/70 px-3 py-2.5 text-sm">
        <RotateCcw className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">Old versions <span className="tabular-nums text-muted-foreground">· {formatBytes(usage.versionBytes)}</span></span>
      </div>}
    </div>}

    <div className="flex flex-col gap-2">
      <Disclosure title="By member" count={usage.members.length}>
        {usage.members.length ? <ul className="flex flex-col gap-2.5 pt-1">
          {usage.members.map((member) => {
            const name = member.id === null ? "Unknown" : member.name || member.email;
            return <li key={member.id ?? "unknown"} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 text-sm">
              <span className="truncate">{name}{member.isYou && <span className="text-muted-foreground"> (you)</span>}</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div className={cn("h-full min-w-0.5 rounded-full", member.isYou ? "bg-primary" : "bg-muted-foreground/50")} style={{ width: `${(member.bytes / largestMember) * 100}%` }} />
              </div>
              <span className="tabular-nums text-muted-foreground">{formatBytes(member.bytes)}</span>
            </li>;
          })}
        </ul> : <p className="pt-1 text-sm text-muted-foreground">No accessible uploads.</p>}
      </Disclosure>

      <Disclosure title="Largest files" count={usage.largestFiles.length}>
        {usage.largestFiles.length ? <ul className="-mx-2 flex flex-col">
          {usage.largestFiles.map((file) => <li key={file.id}>
            <button type="button" onClick={() => onNavigate(file.trashed ? "trash" : "all", file.folderId ?? undefined)}
              aria-label={`${file.name}, ${formatBytes(file.size)}${file.trashed ? ", in Trash" : ""}. Show in folder`}
              className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
              <DriveFileIcon item={{ name: file.name, kind: "file", mimeType: file.mimeType }} />
              <TruncatedText className="min-w-0 flex-1">{file.name}</TruncatedText>
              {file.trashed && <Trash2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(file.size)}</span>
            </button>
          </li>)}
        </ul> : <p className="pt-1 text-sm text-muted-foreground">No files yet.</p>}
      </Disclosure>
    </div>
  </div>;
}

/** Storage used against the drive's and the member's limits, with where it goes and what to clean up. */
export function StorageUsageDialog({ open, onOpenChange, onNavigate }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (filter: DriveFilter, folderId?: string) => void;
}) {
  const query = useStorageUsage();
  const go = (filter: DriveFilter, folderId?: string) => { onOpenChange(false); onNavigate(filter, folderId); };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-5 sm:max-w-md">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-1.5">Storage
          <Hint label="Only items you can access are counted. Private items owned by others are excluded, so the drive can fill up before these totals do.">
            <button type="button" aria-label="About these totals" className="rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Info className="size-3.5" /></button>
          </Hint>
        </DialogTitle>
        <DialogDescription>{query.data ? `${formatBytes(query.data.usedBytes)} of ${formatBytes(query.data.quotaBytes)} used` : "Storage used by items you can access."}</DialogDescription>
      </DialogHeader>
      <div className="-mx-4 max-h-[min(70dvh,640px)] overflow-y-auto px-4 pb-1">
        {query.data ? <UsageDetails usage={query.data} onNavigate={go} />
          : query.isError ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>Could not load storage usage</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">{query.error.message}<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button></AlertDescription></Alert>
          : <div className="flex h-40 items-center justify-center"><Spinner label="Loading storage usage" /></div>}
      </div>
    </DialogContent>
  </Dialog>;
}
