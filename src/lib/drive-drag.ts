"use client";

import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";

// Custom type, so the window-level upload drop zone (which looks for "Files") ignores internal moves.
const DRIVE_ITEMS_TYPE = "application/x-orole-drive-items";

// dataTransfer can't be read during dragover, so the ids being dragged are kept here for drop targets.
let dragged: readonly string[] | null = null;

export function isDraggingItems() {
  return dragged !== null;
}

export function startItemDrag(event: DragEvent<HTMLElement>, ids: string[]) {
  dragged = ids;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(DRIVE_ITEMS_TYPE, JSON.stringify(ids));
  if (ids.length > 1) {
    const badge = document.createElement("div");
    badge.textContent = `${ids.length} items`;
    badge.className = "fixed -top-24 left-0 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground shadow-lg";
    document.body.append(badge);
    event.dataTransfer.setDragImage(badge, -12, -12);
    requestAnimationFrame(() => badge.remove());
  }
}

export function endItemDrag() {
  dragged = null;
}

export type DropTarget = { id: string | null; name: string };

// Handlers for anything items can be dropped onto: folders and breadcrumbs.
export function itemDropHandlers(target: DropTarget, { onMove, onOver }: {
  onMove: (ids: string[], target: DropTarget) => void;
  onOver: (id: string | null | undefined) => void;
}) {
  const accepts = () => dragged !== null && !dragged.includes(target.id ?? "");
  return {
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!accepts()) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      onOver(target.id);
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onOver(undefined);
    },
    onDrop(event: DragEvent<HTMLElement>) {
      onOver(undefined);
      if (!accepts() || !dragged) return;
      event.preventDefault();
      const ids = [...dragged];
      endItemDrag();
      onMove(ids, target);
    },
  };
}

type Box = { left: number; top: number; width: number; height: number };

// Explorer-style rubber-band selection: press on empty space and drag across [data-drive-item] elements.
export function beginMarquee(event: ReactPointerEvent<HTMLElement>, { selected, onSelect, onBox }: {
  selected: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  onBox: (box: Box | null) => void;
}) {
  if (event.button !== 0 || event.pointerType === "touch") return;
  if ((event.target as Element).closest("[data-drive-item], button, a, input, textarea, select, label, [role=menu], [role=checkbox]")) return;
  event.preventDefault();
  const additive = event.ctrlKey || event.metaKey || event.shiftKey;
  const base = additive ? new Set(selected) : new Set<string>();
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-drive-item]")];
  const start = { x: event.clientX, y: event.clientY };
  let moved = false;

  function move(pointer: PointerEvent) {
    const box = {
      left: Math.min(start.x, pointer.clientX), top: Math.min(start.y, pointer.clientY),
      width: Math.abs(pointer.clientX - start.x), height: Math.abs(pointer.clientY - start.y),
    };
    if (!moved && box.width < 4 && box.height < 4) return;
    moved = true;
    onBox(box);
    const ids = new Set(base);
    for (const element of items) {
      const rect = element.getBoundingClientRect();
      const hit = rect.left < box.left + box.width && rect.right > box.left && rect.top < box.top + box.height && rect.bottom > box.top;
      if (hit && element.dataset.driveItem) ids.add(element.dataset.driveItem);
    }
    onSelect(ids);
  }
  function stop() {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    onBox(null);
    // A plain click on empty space clears the selection, like Explorer.
    if (!moved && !additive) onSelect(new Set());
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}
