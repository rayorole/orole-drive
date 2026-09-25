"use client";

import type { ReactNode } from "react";
import { RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import type { DriveFilter, StorageUsageReport } from "@/lib/drive-types";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format-bytes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/spinner";
import { DriveFileIcon } from "@/components/drive-item";
import { TruncatedText } from "@/components/hint";
import { SEGMENT_COLORS, usageParts, usagePercent, usageSeverity, useStorageUsage } from "@/components/sidebar-status";

function UsageMeter({ label, name, used, quota }: { label: string; name: string; used: number; quota: number }) {
  const ratio = used / quota;
  const percent = usagePercent(used, quota);
  const { color, level } = usageSeverity(ratio);
  const text = `${formatBytes(used)} of ${formatBytes(quota)} (${percent}%)`;
  return <div className="flex flex-col gap-1.5">
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="font-medium">{label}</span>
      <span className="tabular-nums text-muted-foreground">{text}</span>
    </div>
    <div role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={text}
      className="h-2 overflow-hidden rounded-full" style={{ backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)` }}>
      <div className="h-full rounded-full" style={{ width: `${Math.min(ratio, 1) * 100}%`, backgroundColor: color }} />
    </div>
    {level && <p className="flex items-center gap-1.5 text-xs font-medium"><TriangleAlert className="size-3.5 shrink-0" style={{ color }} aria-hidden="true" />
      {level === "full" ? "No space left. Empty Trash or delete old versions to upload again." : `${formatBytes(Math.max(0, quota - used))} left.`}</p>}
  </div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-2.5">
    <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
    {children}
  </section>;
}

function UsageDetails({ usage, onNavigate }: { usage: StorageUsageReport; onNavigate: (filter: DriveFilter, folderId?: string) => void }) {
  const parts = usageParts(usage);

  return <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-4">
      <UsageMeter label="Drive" name="Drive storage" used={usage.usedBytes} quota={usage.quotaBytes} />
      <UsageMeter label="You" name="Your storage" used={usage.memberUsedBytes} quota={usage.memberQuotaBytes} />
    </div>

    <Section title="What’s using space">
      {parts.length ? <>
        <div className="flex h-3 gap-px overflow-hidden rounded-full bg-muted" aria-hidden="true">
          {parts.map((part) => <div key={part.key} className={cn("h-full min-w-1", SEGMENT_COLORS[part.key])} style={{ width: `${(part.bytes / usage.usedBytes) * 100}%` }} />)}
        </div>
        <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {parts.map((part) => <li key={part.key} className="flex items-center gap-2 text-sm">
            <span className={cn("size-2.5 shrink-0 rounded-full", SEGMENT_COLORS[part.key])} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{part.label}{part.detail && <span className="text-muted-foreground"> · {part.detail}</span>}</span>
            <span className="tabular-nums text-muted-foreground">{formatBytes(part.bytes)}</span>
          </li>)}
        </ul>
      </> : <p className="text-sm text-muted-foreground">Nothing stored yet.</p>}
    </Section>

    {(usage.trashBytes > 0 || usage.versionBytes > 0) && <Section title="Free up space">
      <ul className="flex flex-col gap-2">
        {usage.trashBytes > 0 && <li className="flex items-center gap-3 rounded-lg border border-border/70 p-3 text-sm">
          <Trash2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">Empty Trash to free {formatBytes(usage.trashBytes)}.</span>
          <Button variant="outline" size="sm" onClick={() => onNavigate("trash")}>Open Trash</Button>
        </li>}
        {usage.versionBytes > 0 && <li className="flex items-center gap-3 rounded-lg border border-border/70 p-3 text-sm">
          <RotateCcw className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">Old versions use {formatBytes(usage.versionBytes)}. Delete them from a file’s version history.</span>
        </li>}
      </ul>
    </Section>}

    <Section title="By member">
      {usage.members.length ? <ul className="flex flex-col gap-2">
        {usage.members.map((member) => {
          const name = member.id === null ? "Unknown (before tracking)" : member.name || member.email;
          return <li key={member.id ?? "unknown"} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{name}{member.isYou && <span className="text-muted-foreground"> (you)</span>}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(member.bytes)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div className={cn("h-full rounded-full", member.isYou ? "bg-primary" : "bg-muted-foreground/50")} style={{ width: `${(member.bytes / usage.usedBytes) * 100}%` }} />
            </div>
          </li>;
        })}
      </ul> : <p className="text-sm text-muted-foreground">Nobody has added files yet.</p>}
    </Section>

    <Section title="Largest files">
      {usage.largestFiles.length ? <ul className="-mx-2 flex flex-col">
        {usage.largestFiles.map((file) => <li key={file.id}>
          <button type="button" onClick={() => onNavigate(file.trashed ? "trash" : "all", file.folderId ?? undefined)}
            aria-label={`${file.name}, ${formatBytes(file.size)}${file.trashed ? ", in Trash" : ""}. Show in folder`}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
            <DriveFileIcon item={{ name: file.name, kind: "file", mimeType: file.mimeType }} />
            <span className="flex min-w-0 flex-1 flex-col">
              <TruncatedText className="font-medium">{file.name}</TruncatedText>
              {file.trashed && <span className="text-xs text-muted-foreground">In Trash</span>}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(file.size)}</span>
          </button>
        </li>)}
      </ul> : <p className="text-sm text-muted-foreground">No files yet.</p>}
      <p className="text-xs text-muted-foreground">Totals include locked folders; their files are listed only once you unlock them.</p>
    </Section>
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
    <DialogContent className="gap-5 sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Storage</DialogTitle>
        <DialogDescription>{query.data ? `${formatBytes(query.data.usedBytes)} of the family’s ${formatBytes(query.data.quotaBytes)} is in use.` : "How the family’s storage is used."}</DialogDescription>
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
