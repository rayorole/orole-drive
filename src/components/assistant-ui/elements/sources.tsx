"use client";

import { ChevronDownIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { collapsePanel, fieldInteractive, mono, paper } from "./surfaces";

export interface Source {
  domain: string;
  title: string;
  /** Stable key when several sources share a domain. */
  id?: string;
  /** Makes the card a button, e.g. to open the file. */
  onSelect?: () => void;
  /** Dims the card, e.g. for a source the reader can no longer open. */
  disabled?: boolean;
}

export interface SourcesProps {
  sources: readonly Source[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}

export function Sources({
  sources,
  open,
  onOpenChange,
  className,
}: SourcesProps) {
  return (
    <Collapsible
      data-slot="sources"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full max-w-sm", className)}
    >
      <CollapsibleTrigger
        className={cn(
          fieldInteractive,
          "group/trigger text-foreground/60 hover:text-foreground/90 inline-flex w-fit items-center gap-1.5 rounded-full px-3.5 py-2 text-xs outline-none",
        )}
      >
        <span>Sources</span>
        <span className={cn(mono, "text-foreground/35 tabular-nums")}>
          {sources.length}
        </span>
        <ChevronDownIcon className="size-3 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-180 group-data-panel-open/trigger:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <div className="grid grid-cols-2 gap-2 pt-2.5">
          {sources.map((source) => {
            const Card = source.onSelect ? "button" : "div";
            return (
            <Card
              key={source.id ?? source.domain}
              {...(source.onSelect ? { type: "button" as const, onClick: source.onSelect } : {})}
              aria-disabled={source.disabled || undefined}
              className={cn(
                paper,
                "flex flex-col gap-1.5 rounded-2xl p-3 text-start transition-transform hover:-translate-y-px",
                source.disabled && "opacity-50 hover:translate-y-0",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="bg-foreground/[0.06] text-foreground/45 flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-medium">
                  {source.domain.charAt(0).toUpperCase()}
                </span>
                <span className={cn(mono, "text-foreground/40 truncate")}>
                  {source.domain}
                </span>
              </div>
              <span className="text-foreground/90 line-clamp-2 text-[13px] leading-snug font-medium">
                {source.title}
              </span>
            </Card>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
