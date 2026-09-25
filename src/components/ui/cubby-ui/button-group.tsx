import * as React from "react";
import { cn } from "@/lib/utils";

function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="button-group"
      className={cn("flex w-fit items-stretch [&>*:focus-visible]:relative [&>*:focus-visible]:z-10", className)}
      {...props}
    />
  );
}

function ButtonGroupText({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 bg-transparent px-2.5 text-sm [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export { ButtonGroup, ButtonGroupText };
