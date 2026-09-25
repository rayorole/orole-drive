"use client";

import { Command as CommandRoot, CommandEmpty, CommandGroup, CommandInput, CommandList, CommandOption, useCommand } from "@kmenu/react";
import type { CommandOptionType, FilterFunctionType } from "@kmenu/react";
import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { search } from "@/lib/command-filter";
import { cn } from "@/lib/utils";

export interface CommandMenuAction extends Omit<CommandOptionType, "children"> {
  icon?: ReactNode;
  shortcut?: string[];
  /** Right-aligned secondary text, shown when there is no shortcut. */
  hint?: string;
  badge?: string;
  /** Shorter label for the breadcrumb trail once this submenu is open. */
  crumb?: string;
  /** Only listed while searching, so long lists (like files) don't crowd the home level. */
  hidden?: boolean;
  children?: CommandMenuAction[];
}

const EASE = [0.23, 1, 0.32, 1] as const;
// Replayed on the list when the level changes, so entering or leaving a submenu reads as movement.
const LEVEL_ENTER = ["animate-in", "fade-in-0", "slide-in-from-right-2", "duration-150"];

const asAction = (option: CommandOptionType<CommandMenuAction>): CommandMenuAction => option as CommandMenuAction;

const filterActions: FilterFunctionType<CommandMenuAction> = (options, query) => {
  const visible = query.trim() ? options : options.filter((option) => !asAction(option).hidden);
  return search(visible, query);
};

function replay(element: HTMLElement | null | undefined, classes: string[]) {
  if (!element) return;
  element.classList.remove(...classes);
  void element.offsetWidth;
  element.classList.add(...classes);
}

function CommandOptions({ listRef }: { listRef: React.RefObject<HTMLDivElement | null> }) {
  const { command, state } = useCommand<CommandMenuAction>();
  const position = `${state.currentLevel}:${state.breadcrumbs.map((crumb) => crumb.id).join(">")}`;
  const lastPosition = useRef(position);

  // Typing always highlights the best match, so Enter runs what the user is looking at.
  const query = state.input;
  const topId = state.filtered[0]?.id;
  useEffect(() => {
    if (topId) command?.setActiveById(topId);
  }, [command, query, topId]);

  useEffect(() => {
    if (lastPosition.current === position) return;
    lastPosition.current = position;
    replay(listRef.current, LEVEL_ENTER);
  }, [position, listRef]);

  const filtered = state.filtered.map(asAction);
  const groups = [...new Set(filtered.map((action) => action.group))].filter((group) => group !== undefined);
  const ungrouped = filtered.filter((action) => !action.group);

  const renderOption = (action: CommandMenuAction) => (
    <CommandOption key={action.id ?? action.label} value={action} disabled={action.disabled} data-slot="command-option"
      className="command-option relative z-10 flex h-9 cursor-default select-none items-center gap-2 rounded-lg px-2.5 text-[13px] text-foreground outline-none data-[active=true]:text-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50">
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        {action.icon ? <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{action.icon}</span> : null}
        <span className="truncate">{action.label}</span>
      </span>
      {action.badge ? <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{action.badge}</span> : null}
      {action.children ? (
        <ChevronRight className="command-option-more size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : action.shortcut ? (
        <span className="flex shrink-0 items-center gap-1">
          {action.shortcut.map((key) => (
            <kbd key={key} className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-background px-1 font-sans text-[11px] font-medium text-muted-foreground">{key}</kbd>
          ))}
        </span>
      ) : action.hint ? (
        <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{action.hint}</span>
      ) : null}
    </CommandOption>
  );

  if (state.currentLevel > 0) return <>{filtered.map(renderOption)}</>;
  return <>
    {ungrouped.map(renderOption)}
    {groups.map((group) => (
      <CommandGroup key={group} className="pt-1.5 first:pt-0" heading={<div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{group}</div>}>
        {filtered.filter((action) => action.group === group).map(renderOption)}
      </CommandGroup>
    ))}
  </>;
}

const CRUMB = "rounded-md px-1 py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

function Breadcrumbs({ options, scope, onLeaveScope }: { options: CommandMenuAction[]; scope?: string; onLeaveScope: () => void }) {
  const { command, state } = useCommand<CommandMenuAction>();
  const reduced = useReducedMotion();

  const labels = new Map<string, string>();
  const walk = (actions: CommandMenuAction[]) => {
    for (const action of actions) {
      if (action.id) labels.set(action.id, action.crumb ?? action.label);
      if (action.children) walk(action.children);
    }
  };
  walk(options);

  const hidden = reduced ? { opacity: 0 } : { opacity: 0, x: -8, filter: "blur(4px)" };
  const backTo = (depth: number) => {
    for (let left = state.breadcrumbs.length; left > depth; left -= 1) {
      if (!command?.goBack()) break;
    }
  };
  const here = state.breadcrumbs.length;
  const separator = <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden="true" />;

  return <nav aria-label="Command menu location" className="flex h-8 items-center gap-1 overflow-hidden border-b border-border/70 px-3 text-xs text-muted-foreground">
    {here === 0 && !scope ? <span className="px-1 text-foreground">Home</span>
      : <button type="button" className={CRUMB} onClick={() => { backTo(0); onLeaveScope(); }}>Home</button>}
    {scope ? <>{separator}{here === 0 ? <span className="px-1 text-foreground">{scope}</span> : <button type="button" className={CRUMB} onClick={() => backTo(0)}>{scope}</button>}</> : null}
    <AnimatePresence initial={false}>
      {state.breadcrumbs.map(({ id, label }, index) => {
        const motionProps = {
          initial: hidden,
          animate: { opacity: 1, x: 0, filter: "blur(0px)" },
          exit: { ...hidden, transition: { duration: 0.13, ease: EASE } },
          transition: { duration: 0.18, ease: EASE },
        };
        return <motion.span key={id} className="flex min-w-0 items-center gap-1" {...motionProps}>
          {separator}
          {index === here - 1 ? <span className="truncate px-1 text-foreground">{labels.get(id) ?? label}</span>
            : <button type="button" className={cn(CRUMB, "truncate")} onClick={() => backTo(index + 1)}>{labels.get(id) ?? label}</button>}
        </motion.span>;
      })}
    </AnimatePresence>
  </nav>;
}

/** At the top of a scope, Backspace in an empty input leaves the scope, like leaving a submenu. */
function ScopeBackspace({ onLeaveScope }: { onLeaveScope: () => void }) {
  const { state } = useCommand<CommandMenuAction>();
  const depth = state.breadcrumbs.length;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Backspace" || depth > 0) return;
      const target = event.target;
      if (target instanceof HTMLInputElement && target.value !== "") return;
      event.preventDefault();
      onLeaveScope();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [depth, onLeaveScope]);
  return null;
}

const OPEN_EVENT = "orole:open-command-menu";

export function openCommandMenu(scope?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { scope } }));
}

declare global {
  interface WindowEventMap {
    [OPEN_EVENT]: CustomEvent<{ scope?: string }>;
  }
}

const OPEN_OVERLAY = ':is([role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]):is([data-open],[data-state="open"])';
const CLOSE_MS = 160;

function withoutActions(actions: CommandMenuAction[]): CommandMenuAction[] {
  return actions.map((action) => ({ ...action, action: undefined, children: action.children && withoutActions(action.children) }));
}

/** kmenu hands back its own copy of the option; match it to the caller's current action by id. */
function findAction(actions: CommandMenuAction[], option: CommandOptionType): CommandMenuAction | undefined {
  for (const action of actions) {
    if (option.id !== undefined ? action.id === option.id : action.label === option.label) return action;
    const nested = action.children && findAction(action.children, option);
    if (nested) return nested;
  }
  return undefined;
}

/** An entry built from what the user typed, e.g. "Search inside files for …", listed after the matches. `group` must be one the actions already use. */
export type CommandMenuQueryAction = { id: string; group?: string; icon?: ReactNode; minLength: number; label: (query: string) => string; run: (query: string) => void };

export function CommandMenu({ actions, scopes, queryAction, placeholder = "Type a command or search…", className }: {
  actions: CommandMenuAction[];
  scopes?: Record<string, { actions: CommandMenuAction[]; placeholder: string; crumb?: string }>;
  queryAction?: CommandMenuQueryAction;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  // Height follows the content only after the entrance, so the first frame never animates from 0.
  const [ready, setReady] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const scoped = scope ? scopes?.[scope] : undefined;
  // kmenu resolves clicks against the options it was given, so the query entry is registered (hidden)
  // up front; the filter below relabels it with what was typed.
  const current = scoped?.actions ?? (queryAction ? [...actions, { id: queryAction.id, group: queryAction.group, icon: queryAction.icon, label: queryAction.label(""), hidden: true }] : actions);
  // kmenu drops back to the top level whenever it receives new options, and callers rebuild their
  // actions (with fresh closures) on every render. Hand it options that only change with their
  // visible content, and run the caller's latest `action` by id when one is picked.
  const signature = JSON.stringify(current, (key, value: unknown) => (key === "icon" || key === "action" ? undefined : value));
  const [stable, setStable] = useState(() => ({ signature, options: withoutActions(current) }));
  if (stable.signature !== signature) setStable({ signature, options: withoutActions(current) });
  const latest = useRef(current);
  useEffect(() => {
    latest.current = current;
  });
  // Read at filter/select time, so a new closure each render doesn't hand kmenu a new filter.
  const latestQueryAction = useRef(queryAction);
  const typed = useRef("");
  useEffect(() => {
    latestQueryAction.current = queryAction;
  });
  const hasQueryAction = Boolean(queryAction) && !scoped;
  const filter = useCallback<FilterFunctionType<CommandMenuAction>>((options, query) => {
    const extra = latestQueryAction.current;
    const found = filterActions(options, query).filter((option) => !extra || option.id !== extra.id);
    typed.current = query.trim();
    const entry = extra && options.find((option) => option.id === extra.id);
    if (!hasQueryAction || !extra || !entry || typed.current.length < extra.minLength) return found;
    return [...found, { ...entry, label: extra.label(typed.current) }];
  }, [hasQueryAction]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const sizer = sizerRef.current;
    if (!open || !dialog || !sizer) return;
    const style = getComputedStyle(dialog);
    const chrome = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize?.[0];
      if (box) dialog.style.height = `${box.blockSize + chrome}px`;
    });
    observer.observe(sizer);
    return () => {
      observer.disconnect();
      dialog.style.removeProperty("height");
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timeout = window.setTimeout(() => setReady(true), 180);
    return () => { window.clearTimeout(timeout); setReady(false); };
  }, [open]);

  const leaveScope = useCallback(() => setScope(null), []);

  const handleClose = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    window.setTimeout(() => {
      // Return focus to where the menu was opened from, unless the chosen action already moved it.
      const active = document.activeElement;
      const stayed = !active || active === document.body || overlayRef.current?.contains(active);
      setOpen(false);
      setIsClosing(false);
      if (stayed) returnFocus.current?.focus({ preventScroll: true });
    }, CLOSE_MS);
  }, [isClosing]);

  const openMenu = useCallback((next: string | null = null) => {
    setScope(next);
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Another overlay owns focus: ask it to close first, then open once it has left the DOM.
    const overlay = document.querySelector(OPEN_OVERLAY);
    if (!overlay) return setOpen(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const start = performance.now();
    const openWhenGone = () => {
      if (!overlay.isConnected || performance.now() - start > 500) setOpen(true);
      else requestAnimationFrame(openWhenGone);
    };
    requestAnimationFrame(openWhenGone);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl/⌘ K, and Ctrl/⌘ F in place of the browser's find-in-page: search is the command menu here.
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (key === "k" || key === "f")) {
        event.preventDefault();
        if (open) handleClose();
        else openMenu();
      } else if (event.key === "Escape" && open && !isClosing) {
        event.preventDefault();
        handleClose();
      }
    };
    const onOpen = (event: WindowEventMap[typeof OPEN_EVENT]) => openMenu(event.detail?.scope ?? null);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [handleClose, isClosing, open, openMenu]);

  const select = (option: CommandOptionType) => {
    const extra = latestQueryAction.current;
    if (extra && option.id === extra.id) extra.run(typed.current);
    else void findAction(latest.current, option)?.action?.();
    handleClose();
  };

  if (!open) return null;
  const options = stable.options;

  return <div ref={overlayRef} data-slot="command-menu" data-closing={isClosing || undefined} role="dialog" aria-modal="true" aria-label="Command menu"
    className="command-overlay fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12dvh] sm:pt-[16dvh]">
    <button type="button" tabIndex={-1} aria-label="Close command menu" onClick={() => !isClosing && handleClose()}
      className="absolute inset-0 cursor-default bg-black/10 duration-150 animate-in fade-in-0 supports-backdrop-filter:backdrop-blur-xs in-data-closing:animate-out in-data-closing:fade-out-0 in-data-closing:fill-mode-forwards" />
    <div ref={dialogRef} data-ready={ready || undefined}
      className={cn(
        "command-dialog relative w-full max-w-[34rem] overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-(--surface-shadow) ring-1 ring-foreground/10",
        "origin-top duration-200 ease-(--surface-ease) animate-in fade-in-0 zoom-in-97 slide-in-from-top-1",
        "in-data-closing:duration-150 in-data-closing:animate-out in-data-closing:fade-out-0 in-data-closing:zoom-out-98 in-data-closing:fill-mode-forwards",
        "data-ready:transition-[height] data-ready:duration-200 data-ready:ease-(--surface-ease) motion-reduce:transition-none",
        className,
      )}>
      <div ref={sizerRef}>
        <CommandRoot open={open} onOpenChange={() => undefined} options={options} filter={filter} onSelect={select} className="flex flex-col">
          <ScopeBackspace onLeaveScope={leaveScope} />
          <div className="flex h-12 items-center gap-2 border-b border-border/70 pl-4 pr-2.5">
            <CommandInput autoFocus placeholder={scoped?.placeholder ?? placeholder} data-slot="command-input"
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            <button type="button" data-slot="command-close" onClick={handleClose}
              className="inline-flex h-6 shrink-0 items-center rounded-md border border-border px-1.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Esc</button>
          </div>
          <Breadcrumbs options={options} scope={scoped?.crumb} onLeaveScope={leaveScope} />
          <CommandList ref={listRef} indicatorOffsetY={0}
            className="command-list relative max-h-[min(22rem,60dvh)] overflow-y-auto overscroll-contain p-1.5 [&>.command-active-indicator]:pointer-events-none [&>.command-active-indicator]:absolute [&>.command-active-indicator]:left-0 [&>.command-active-indicator]:top-0 [&>.command-active-indicator]:rounded-lg [&>.command-active-indicator]:bg-accent [&>.command-active-indicator]:transition-[transform,height,opacity] [&>.command-active-indicator]:duration-150 [&>.command-active-indicator]:ease-(--surface-ease) motion-reduce:[&>.command-active-indicator]:transition-none">
            <CommandEmpty className="px-3 py-8 text-center text-sm text-muted-foreground">No results found.</CommandEmpty>
            <CommandOptions listRef={listRef} />
          </CommandList>
        </CommandRoot>
      </div>
    </div>
  </div>;
}
