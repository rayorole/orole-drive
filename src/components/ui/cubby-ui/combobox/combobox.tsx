"use client";

import * as React from "react";
import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

const useComboboxFilter = BaseCombobox.useFilter;
const useComboboxFilteredItems = BaseCombobox.useFilteredItems;

const ComboboxContext = React.createContext<{ id: string } | null>(null);

function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: BaseCombobox.Root.Props<Value, Multiple>,
): React.JSX.Element {
  const id = React.useId();
  const contextValue = React.useMemo(() => ({ id }), [id]);
  return (
    <ComboboxContext.Provider value={contextValue}>
      <BaseCombobox.Root data-slot="combobox" {...props} />
    </ComboboxContext.Provider>
  );
}

function ComboboxInput({
  id: idProp,
  className,
  inputClassName,
  showTrigger = true,
  showClear = true,
  start,
  end,
  ...props
}: BaseCombobox.Input.Props & {
  showTrigger?: boolean;
  showClear?: boolean;
  start?: React.ReactNode;
  end?: React.ReactNode;
  inputClassName?: string;
}) {
  const context = React.use(ComboboxContext);
  const id = idProp ?? context?.id;
  return (
    <BaseCombobox.InputGroup
      data-slot="combobox-input-group"
      className={cn(
        "flex h-9 w-full min-w-0 cursor-text items-center gap-2 rounded-lg border border-input bg-transparent px-2.5",
        "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        "has-[input:disabled]:pointer-events-none has-[input:disabled]:opacity-50",
        className,
      )}
    >
      {start != null && <div className="text-muted-foreground flex shrink-0 items-center [&_svg]:size-4">{start}</div>}
      <BaseCombobox.Input
        id={id}
        data-slot="combobox-input"
        className={cn(
          "placeholder:text-muted-foreground h-full min-w-0 flex-1 border-none bg-transparent p-0 text-sm outline-none disabled:cursor-not-allowed",
          inputClassName,
        )}
        {...props}
      />
      {end != null && <div className="text-muted-foreground flex shrink-0 items-center [&_svg]:size-4">{end}</div>}
      {(showClear || showTrigger) && <div className="flex shrink-0 items-center gap-1.5">
        {showClear && <ComboboxClear />}
        {showTrigger && <ComboboxTrigger />}
      </div>}
    </BaseCombobox.InputGroup>
  );
}

function ComboboxTrigger({ className, children, ...props }: BaseCombobox.Trigger.Props) {
  return (
    <BaseCombobox.Trigger
      data-slot="combobox-trigger"
      aria-label="Open popup"
      className={cn(
        "inline-flex size-4 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-60",
        className,
      )}
      {...props}
    >
      {children ?? <ChevronDown className="size-4" strokeWidth={2} />}
    </BaseCombobox.Trigger>
  );
}

function ComboboxClear({ className, ...props }: BaseCombobox.Clear.Props) {
  return (
    <BaseCombobox.Clear
      data-slot="combobox-clear"
      aria-label="Clear selection"
      className={cn(
        "inline-flex size-4 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/70 disabled:pointer-events-none",
        "data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    >
      <X className="size-4" strokeWidth={2} />
    </BaseCombobox.Clear>
  );
}

function ComboboxValue({ ...props }: BaseCombobox.Value.Props) {
  return <BaseCombobox.Value data-slot="combobox-value" {...props} />;
}

function ComboboxPortal({ ...props }: BaseCombobox.Portal.Props) {
  return <BaseCombobox.Portal data-slot="combobox-portal" {...props} />;
}

function ComboboxPositioner({ className, ...props }: BaseCombobox.Positioner.Props) {
  return (
    <BaseCombobox.Positioner
      data-slot="combobox-positioner"
      sideOffset={6}
      className={cn("z-50", className)}
      {...props}
    />
  );
}

function ComboboxStatus({ className, ...props }: BaseCombobox.Status.Props) {
  return (
    <BaseCombobox.Status
      data-slot="combobox-status"
      className={cn("text-muted-foreground px-2.5 py-2 text-sm empty:m-0 empty:p-0", className)}
      {...props}
    />
  );
}

function ComboboxEmpty({ className, ...props }: BaseCombobox.Empty.Props) {
  return (
    <BaseCombobox.Empty
      data-slot="combobox-empty"
      className={cn("text-muted-foreground px-2.5 py-2 text-sm empty:m-0 empty:p-0", className)}
      {...props}
    />
  );
}

function ComboboxList({ className, ...props }: BaseCombobox.List.Props) {
  return (
    <BaseCombobox.List
      data-slot="combobox-list"
      className={cn("max-h-64 overflow-y-auto overscroll-contain p-1", className)}
      {...props}
    />
  );
}

function ComboboxItem({ className, children, ref, ...props }: BaseCombobox.Item.Props & { ref?: React.Ref<HTMLDivElement> }) {
  return (
    <BaseCombobox.Item
      ref={ref}
      data-slot="combobox-item"
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground relative grid cursor-default grid-cols-[1fr_1rem] items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <div className="break-all">{children}</div>
      <BaseCombobox.ItemIndicator render={<Check className="size-4" strokeWidth={2} />} />
    </BaseCombobox.Item>
  );
}

function ComboboxPopup({
  className,
  children,
  side,
  align,
  sideOffset = 6,
  alignOffset,
  collisionBoundary,
  collisionPadding,
  sticky,
  positionMethod,
  ...props
}: BaseCombobox.Popup.Props & {
  side?: BaseCombobox.Positioner.Props["side"];
  align?: BaseCombobox.Positioner.Props["align"];
  sideOffset?: BaseCombobox.Positioner.Props["sideOffset"];
  alignOffset?: BaseCombobox.Positioner.Props["alignOffset"];
  collisionBoundary?: BaseCombobox.Positioner.Props["collisionBoundary"];
  collisionPadding?: BaseCombobox.Positioner.Props["collisionPadding"];
  sticky?: BaseCombobox.Positioner.Props["sticky"];
  positionMethod?: BaseCombobox.Positioner.Props["positionMethod"];
}) {
  return (
    <ComboboxPortal>
      <ComboboxPositioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding}
        sticky={sticky}
        positionMethod={positionMethod}
      >
        <BaseCombobox.Popup
          data-slot="combobox-popup"
          className={cn(
            "flex max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) flex-col overflow-clip overscroll-contain rounded-lg border bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </BaseCombobox.Popup>
      </ComboboxPositioner>
    </ComboboxPortal>
  );
}

export {
  Combobox,
  ComboboxInput,
  ComboboxTrigger,
  ComboboxClear,
  ComboboxValue,
  ComboboxPortal,
  ComboboxPositioner,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxEmpty,
  ComboboxList,
  ComboboxItem,
  useComboboxFilter,
  useComboboxFilteredItems,
};
