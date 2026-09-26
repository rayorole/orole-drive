"use client";

import type { ComponentProps } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface GenerationLoaderProps extends Omit<
  ComponentProps<"div">,
  "children"
> {
  label: string;
}

export function GenerationLoader({
  label,
  className,
  ...props
}: GenerationLoaderProps) {
  return (
    <div
      data-slot="generation-loader"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn("flex min-h-6 items-center gap-2 py-1 text-sm text-muted-foreground", className)}
      {...props}
    >
      <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin" />
      <span>{label}</span>
    </div>
  );
}
