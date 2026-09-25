"use client";

import * as React from "react";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { cn } from "@/lib/utils";
import { Check, ChevronRight } from "lucide-react";

// Shared shell for checkbox and radio items. Padding matches the plain menu
// item so labels line up across every item type; the indicator lives in a
// reserved right-hand column so toggling never shifts the label.
const toggleItemClasses =
  "data-highlighted:bg-accent data-highlighted:text-accent-foreground grid cursor-default items-center rounded-md px-2.5 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-60 data-inset:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";


function ContextMenu({
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Root>) {
  return <BaseContextMenu.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Trigger>) {
  return (
    <BaseContextMenu.Trigger data-slot="context-menu-trigger" {...props} />
  );
}

function ContextMenuGroup({
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Group>) {
  return <BaseContextMenu.Group data-slot="context-menu-group" {...props} />;
}

function ContextMenuPortal({
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Portal>) {
  return <BaseContextMenu.Portal data-slot="context-menu-portal" {...props} />;
}

function ContextMenuPositioner({
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Positioner>) {
  return (
    <BaseContextMenu.Positioner
      data-slot="context-menu-positioner"
      {...props}
    />
  );
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof BaseContextMenu.RadioGroup>) {
  return (
    <BaseContextMenu.RadioGroup
      data-slot="context-menu-radio-group"
      {...props}
    />
  );
}

function ContextMenuContent({
  className,
  sideOffset = 4,
  align = "start",
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Popup> & {
  align?: BaseContextMenu.Positioner.Props["align"];
  sideOffset?: BaseContextMenu.Positioner.Props["sideOffset"];
}) {
  return (
    <ContextMenuPortal>
      <ContextMenuPositioner
        className="max-h-(--available-height) max-w-(--available-width)"
        align={align}
        sideOffset={sideOffset}
      >
        <BaseContextMenu.Popup
          data-slot="context-menu-content"
          className={cn(
            // No Menu.Viewport here (ContextMenu has no trigger-swap morph to run
            // one for), so the popup is its own scroll container: capped at
            // --available-height, clipping on x for the rounded corners and
            // scrolling on y. Without the cap a tall menu runs off screen.
            "relative z-50 max-h-(--available-height) max-w-(--available-width) min-w-[12rem] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-(--surface-shadow) outline-none",
            // Modern enter/exit — scale + fade from the transform origin, matching
            // popover/dropdown-menu (replaces the legacy animate-in/zoom/slide classes)
            "ease-(--surface-ease) transition-[scale,opacity] duration-100",
            "data-starting-style:scale-95 data-starting-style:opacity-0",
            "data-ending-style:scale-95 data-ending-style:opacity-0",
            // No data-instant guard, deliberately: 'click' is inferred from
            // `event.detail === 0`, which every right-click matches, so it would
            // kill the enter animation on every open. 'dismiss' must animate or
            // there is no exit, and 'group' / 'trigger-change' cannot fire here.
            "motion-reduce:transition-none",
            className,
          )}
          {...props}
        />
      </ContextMenuPositioner>
    </ContextMenuPortal>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <BaseContextMenu.Item
      data-slot="context-menu-item"
      data-inset={inset || undefined}
      data-variant={variant}
      className={cn(
        "data-highlighted:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:data-highlighted:bg-destructive/15 data-[variant=destructive]:data-highlighted:text-destructive data-[variant=destructive]:*:[svg]:text-destructive! [&_svg:not([class*='text-'])]:text-muted-foreground data-highlighted:bg-accent relative flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-60 data-inset:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuLinkItem({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.LinkItem> & {
  inset?: boolean;
}) {
  return (
    <BaseContextMenu.LinkItem
      data-slot="context-menu-link-item"
      data-inset={inset || undefined}
      className={cn(
        "data-highlighted:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground data-highlighted:bg-accent relative flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-sm no-underline outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-60 data-inset:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuCheckboxItem({
  className, children, inset, ...props
}: React.ComponentProps<typeof BaseContextMenu.CheckboxItem> & { inset?: boolean }) {
  return (
    <BaseContextMenu.CheckboxItem
      data-slot="context-menu-checkbox-item"
      data-inset={inset || undefined}
      className={cn(toggleItemClasses, "grid-cols-[1fr_1rem] gap-2", className)}
      {...props}
    >
      <span className="col-start-1 flex min-w-0 items-center gap-2">{children}</span>
      <BaseContextMenu.CheckboxItemIndicator className="col-start-2 flex items-center justify-center">
        <Check className="size-4" strokeWidth={2.5} />
      </BaseContextMenu.CheckboxItemIndicator>
    </BaseContextMenu.CheckboxItem>
  );
}

function ContextMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.RadioItem> & {
  inset?: boolean;
}) {
  return (
    <BaseContextMenu.RadioItem
      data-slot="context-menu-radio-item"
      data-inset={inset || undefined}
      className={cn(toggleItemClasses, "grid-cols-[1fr_1rem] gap-2", className)}
      {...props}
    >
      <span className="col-start-1 flex min-w-0 items-center gap-2">
        {children}
      </span>
      <BaseContextMenu.RadioItemIndicator
        className="col-start-2 flex items-center justify-center"
      >
        <Check className="size-4" strokeWidth={2.5} />
      </BaseContextMenu.RadioItemIndicator>
    </BaseContextMenu.RadioItem>
  );
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean;
}) {
  return (
    <div
      data-slot="context-menu-label"
      data-inset={inset || undefined}
      className={cn(
        "px-2.5 py-1.5 text-xs font-medium data-inset:pl-8",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuGroupLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.GroupLabel> & {
  inset?: boolean;
}) {
  return (
    <BaseContextMenu.GroupLabel
      data-slot="context-menu-group-label"
      data-inset={inset || undefined}
      className={cn(
        "px-2.5 py-1.5 text-xs font-medium data-inset:pl-8",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Separator>) {
  return (
    <BaseContextMenu.Separator
      data-slot="context-menu-separator"
      // Inset to the item label, not the popup edge: mx-2.5 clears the popup's
      // p-1 plus the item's px-2.5, so the rule starts where the text does
      // instead of running into the popup's rounded corners.
      className={cn("bg-border mx-2.5 my-1 h-px", className)}
      {...props}
    />
  );
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        "text-muted-foreground ml-auto text-xs tracking-widest",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof BaseContextMenu.SubmenuRoot>) {
  return (
    <BaseContextMenu.SubmenuRoot data-slot="context-menu-sub" {...props} />
  );
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  delay = 0,
  closeDelay = 0,
  ...props
}: React.ComponentProps<typeof BaseContextMenu.SubmenuTrigger> & {
  inset?: boolean;
}) {
  return (
    <BaseContextMenu.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset || undefined}
      delay={delay}
      closeDelay={closeDelay}
      className={cn(
        "data-highlighted:text-accent-foreground data-popup-open:text-accent-foreground data-highlighted:bg-accent data-popup-open:bg-accent flex cursor-default items-center rounded-md px-2.5 py-1.5 text-sm outline-hidden select-none data-inset:pl-8",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-4" strokeWidth={2} />
    </BaseContextMenu.SubmenuTrigger>
  );
}

function ContextMenuSubContent({
  className,
  // 8px, not 0: the positioner anchors to the sub-trigger, which sits 4px
  // inside the parent popup because of its p-1. A 0 offset therefore overlaps
  // the parent's edge by 4px; 8 leaves a 4px gap, matching Menubar.
  sideOffset = 8,
  align = "start",
  ...props
}: React.ComponentProps<typeof BaseContextMenu.Popup> & {
  align?: BaseContextMenu.Positioner.Props["align"];
  sideOffset?: BaseContextMenu.Positioner.Props["sideOffset"];
}) {
  return (
    <ContextMenuPortal>
      <ContextMenuPositioner
        className="max-h-(--available-height) max-w-(--available-width)"
        sideOffset={sideOffset}
        align={align}
      >
        <BaseContextMenu.Popup
          data-slot="context-menu-sub-content"
          className={cn(
            // Its own scroll container, like ContextMenuContent above.
            "relative z-50 max-h-(--available-height) max-w-(--available-width) min-w-[12rem] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-(--surface-shadow) outline-none",
            // Modern enter/exit — scale + fade from the transform origin, matching
            // popover/dropdown-menu (replaces the legacy animate-in/zoom/slide classes)
            "ease-(--surface-ease) transition-[scale,opacity] duration-100",
            "data-starting-style:scale-95 data-starting-style:opacity-0",
            "data-ending-style:scale-95 data-ending-style:opacity-0",
            // See ContextMenuContent for why there is no data-instant guard.
            "motion-reduce:transition-none",
            className,
          )}
          {...props}
        />
      </ContextMenuPositioner>
    </ContextMenuPortal>
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLinkItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
  ContextMenuSeparator,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuGroupLabel,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuPortal,
  ContextMenuPositioner,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
};
