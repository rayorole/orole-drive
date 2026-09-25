"use client";

import { useState, type ComponentProps, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  DndContext, DragOverlay, PointerSensor, pointerWithin, useDndContext, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent, type Modifier,
} from "@dnd-kit/core";
import { cn } from "@/lib/utils";

export type DropTarget = { id: string | null; name: string };
type DragData = { ids: string[] };
type DropData = { target: DropTarget };

/**
 * Pointer-driven drag and drop for moving drive items. Unlike native HTML drag and drop, the browser
 * never snapshots the row, so the preview is only the small overlay rendered here.
 */
// The overlay starts where the dragged row sits; shift it so the preview chip sits just below-right of the cursor.
const followCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!draggingNodeRect || !activatorEvent || !("clientX" in activatorEvent)) return transform;
  const pointer = activatorEvent as PointerEvent;
  return { ...transform, x: transform.x + pointer.clientX - draggingNodeRect.left + 12, y: transform.y + pointer.clientY - draggingNodeRect.top + 10 };
};

export function DriveDndProvider({ children, enabled, renderPreview, onMove }: {
  children: ReactNode;
  enabled: boolean;
  renderPreview: (ids: string[]) => ReactNode;
  onMove: (ids: string[], target: DropTarget) => void;
}) {
  const [dragging, setDragging] = useState<string[] | null>(null);
  // A few pixels of movement before a drag starts, so clicks, double-clicks and checkboxes still work.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function start(event: DragStartEvent) {
    setDragging((event.active.data.current as DragData | undefined)?.ids ?? null);
  }
  function end(event: DragEndEvent) {
    setDragging(null);
    const ids = (event.active.data.current as DragData | undefined)?.ids;
    const target = (event.over?.data.current as DropData | undefined)?.target;
    if (!ids?.length || !target || ids.includes(target.id ?? "")) return;
    onMove(ids, target);
  }

  return <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={start} onDragEnd={end} onDragCancel={() => setDragging(null)}
    accessibility={{ screenReaderInstructions: { draggable: "Drag onto a folder to move it. Press Escape to cancel." } }}>
    {children}
    <DragOverlay dropAnimation={null} modifiers={[followCursor]} className="pointer-events-none">{enabled && dragging ? renderPreview(dragging) : null}</DragOverlay>
  </DndContext>;
}

function useDraggingIds() {
  return (useDndContext().active?.data.current as DragData | undefined)?.ids ?? null;
}

/** Makes a drive row or card draggable and, for folders, a drop target. Spread `dragListeners` on the element. */
export function useDriveItemDnd(item: { id: string; name: string; kind: "file" | "folder"; isLocked: boolean }, { enabled, dragIds }: {
  enabled: boolean;
  dragIds: (id: string) => string[];
}) {
  const dragging = useDraggingIds();
  const draggable = useDraggable({ id: item.id, disabled: !enabled, data: { ids: enabled ? dragIds(item.id) : [] } satisfies DragData });
  const droppable = useDroppable({
    id: `folder:${item.id}`,
    disabled: !enabled || item.kind !== "folder" || item.isLocked || Boolean(dragging?.includes(item.id)),
    data: { target: { id: item.id, name: item.name } } satisfies DropData,
  });
  return {
    ref(node: HTMLElement | null) { draggable.setNodeRef(node); droppable.setNodeRef(node); },
    // Only the pointer listeners: dnd-kit's role/tabIndex attributes would break table row semantics.
    dragListeners: enabled ? draggable.listeners : undefined,
    isDragged: Boolean(dragging?.includes(item.id)),
    isOver: droppable.isOver,
  };
}

/** A breadcrumb button that also accepts dropped items. */
export function DroppableCrumb({ target, disabled, className, ...props }: ComponentProps<"button"> & { target: DropTarget }) {
  const dragging = useDraggingIds();
  const { setNodeRef, isOver } = useDroppable({
    id: `crumb:${target.id ?? "root"}`,
    disabled: Boolean(disabled) || Boolean(dragging?.includes(target.id ?? "")),
    data: { target } satisfies DropData,
  });
  return <button ref={setNodeRef} className={cn(className, isOver && "bg-primary/10 text-foreground ring-2 ring-primary/60")} {...props} />;
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
