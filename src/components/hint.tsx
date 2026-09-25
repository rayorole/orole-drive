"use client";

import { useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/cubby-ui/tooltip";

type Side = ComponentProps<typeof TooltipContent>["side"];

/**
 * Cubby tooltip around a single element (usually an icon button), in place of a native `title`.
 * The element keeps its own aria-label: the tooltip is a visual hint, not its accessible name.
 */
export function Hint({ label, side, children }: { label: ReactNode; side?: Side; children: ReactElement }) {
  // Always the same tree, disabled when there's nothing to say, so the wrapped element never remounts.
  const empty = label === null || label === undefined || label === false || label === "";
  return <Tooltip disabled={empty}>
    <TooltipTrigger render={children} />
    {!empty && <TooltipContent side={side} className="max-w-72">{label}</TooltipContent>}
  </Tooltip>;
}

/** Single-line truncated text that shows the full value in a tooltip, but only when it is actually cut off. */
export function TruncatedText({ children, as = "span", className }: { children: string; as?: "span" | "p" | "h1"; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const Tag = as;
  return <Tooltip open={open} onOpenChange={(next) => setOpen(next && Boolean(ref.current && ref.current.scrollWidth > ref.current.clientWidth))}>
    <TooltipTrigger render={<Tag ref={ref as never} className={cn("truncate", className)} />}>{children}</TooltipTrigger>
    <TooltipContent className="max-w-80 break-words">{children}</TooltipContent>
  </Tooltip>;
}
