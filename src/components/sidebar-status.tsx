"use client";

import { useQuery } from "@tanstack/react-query";
import { PolarAngleAxis, RadialBar, RadialBarChart } from "recharts";
import { HardDrive, Plug, TriangleAlert } from "lucide-react";
import { getConnectedAgents } from "@/app/actions/mcp-status";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/components/drive-item";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { Hint } from "@/components/hint";

/** The family plan's storage allowance. formatBytes counts in 1024s, so this reads as "10 GB". */
export const STORAGE_LIMIT_BYTES = 10 * 1024 ** 3;

// The fill carries severity; the unfilled track is a faint step of the same color, so the ring reads as one meter.
function severity(ratio: number) {
  if (ratio >= 0.95) return { color: "var(--destructive)", note: ratio >= 1 ? "Storage full" : "Almost full" };
  if (ratio >= 0.8) return { color: "oklch(76.9% 0.188 70.08)", note: "Running low" }; // Tailwind amber-500
  return { color: "var(--primary)", note: null };
}

function UsageRing({ ratio, className }: { ratio: number; className?: string }) {
  const { color } = severity(ratio);
  const config = { used: { label: "Used", color } } satisfies ChartConfig;
  return <ChartContainer config={config} aria-hidden="true"
    className={cn("aspect-square [&_.recharts-radial-bar-background-sector]:fill-[color-mix(in_oklab,var(--color-used)_16%,transparent)]", className)}>
    <RadialBarChart data={[{ used: Math.min(ratio, 1) * 100 }]} startAngle={90} endAngle={-270} innerRadius="72%" outerRadius="100%" barSize={6}>
      <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
      <RadialBar dataKey="used" background cornerRadius={4} fill="var(--color-used)" isAnimationActive={false} />
    </RadialBarChart>
  </ChartContainer>;
}

export function StorageCard({ totalBytes, totalFiles, collapsed }: { totalBytes?: number; totalFiles?: number; collapsed: boolean }) {
  const ratio = totalBytes === undefined ? 0 : totalBytes / STORAGE_LIMIT_BYTES;
  const percent = Math.round(ratio * 100);
  const summary = totalBytes === undefined ? "Storage usage unavailable" : `${formatBytes(totalBytes)} of ${formatBytes(STORAGE_LIMIT_BYTES)} used (${percent}%)`;
  const { note } = severity(ratio);

  if (collapsed) return <Hint label={summary} side="right"><div className="flex justify-center" role="img" aria-label={summary}>
    {totalBytes === undefined ? <HardDrive className="size-4 text-muted-foreground" /> : <UsageRing ratio={ratio} className="size-8" />}
  </div></Hint>;

  return <Card size="sm" className="mx-3 flex-row items-center gap-3 px-3 shadow-none" role="group" aria-label="Family storage">
    <div className="relative size-14 shrink-0">
      {totalBytes === undefined
        ? <div className="flex size-full items-center justify-center rounded-full bg-muted"><HardDrive className="size-4 text-muted-foreground" /></div>
        : <><UsageRing ratio={ratio} className="size-full" /><span className="absolute inset-0 flex items-center justify-center text-[11px] font-medium">{percent}%</span></>}
    </div>
    <div className="min-w-0">
      <p className="text-xs font-medium">Family storage</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{totalBytes === undefined ? "Usage unavailable" : <>{formatBytes(totalBytes)} of {formatBytes(STORAGE_LIMIT_BYTES)}</>}</p>
      {note
        ? <p className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-foreground"><TriangleAlert className="size-3 shrink-0" style={{ color: severity(ratio).color }} />{note}</p>
        : totalFiles !== undefined && <p className="mt-0.5 text-[11px] text-muted-foreground">{totalFiles.toLocaleString()} {totalFiles === 1 ? "file" : "files"}</p>}
    </div>
  </Card>;
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

/** Opens the connection dialog; shows a green dot and the count once an assistant is connected. */
export function AgentConnectButton({ collapsed, onConnect }: { collapsed: boolean; onConnect: () => void }) {
  const agents = useConnectedAgents().data;
  const count = agents?.count ?? 0;
  const label = count ? `${count} ${count === 1 ? "agent" : "agents"} connected` : "Connect an agent";
  const title = count ? `${label}: ${agents!.names.join(", ")}` : "Connect an AI assistant with MCP";
  const dot = <span className="relative flex size-2 shrink-0" aria-hidden="true">
    <span className="absolute inline-flex size-full rounded-full bg-emerald-500 opacity-60 motion-safe:animate-ping [animation-duration:2.5s]" />
    <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
  </span>;
  return <div className="px-3">
    <Hint label={title} side="right"><Button variant="ghost" className={cn("relative w-full justify-start", collapsed && "justify-center px-0")} aria-label={label} onClick={onConnect}>
      <Plug />
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      {count > 0 && (collapsed ? <span className="absolute right-2 top-1.5">{dot}</span> : dot)}
    </Button></Hint>
  </div>;
}
