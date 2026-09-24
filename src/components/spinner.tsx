"use client";

import { Ring } from "loading-dev";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export function Spinner({ className, size = 18, label = "Loading" }: { className?: string; size?: number; label?: string }) {
  const reducedMotion = useReducedMotion();
  return <span role="status" className={cn("inline-flex shrink-0 items-center justify-center align-middle leading-none", className)}>
    <Ring size={size} playState={reducedMotion ? "paused" : "running"} aria-hidden="true" />
    <span className="sr-only">{label}</span>
  </span>;
}
