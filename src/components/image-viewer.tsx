"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Maximize, Minimize, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Hint } from "@/components/hint";

const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

/** Fit-to-view by default; zooming switches to real pixels with scroll and drag panning. */
export function ImageViewer({ src, alt, onError }: { src: string; alt: string; onError: () => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === frame.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);

  function fitScale() {
    const img = image.current;
    return img && natural ? img.getBoundingClientRect().width / natural.width : 1;
  }
  /** Keeps the point under the cursor (or the view center) fixed while the scale changes. */
  function applyZoom(next: number | null, anchor?: { x: number; y: number }) {
    const view = viewport.current;
    if (!view || next === null) return setZoom(null);
    const rect = view.getBoundingClientRect();
    const point = anchor ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const imageRect = image.current?.getBoundingClientRect();
    const relX = imageRect ? (point.x - imageRect.left) / (imageRect.width || 1) : 0.5;
    const relY = imageRect ? (point.y - imageRect.top) / (imageRect.height || 1) : 0.5;
    setZoom(next);
    requestAnimationFrame(() => {
      const img = image.current;
      if (!img || !viewport.current) return;
      viewport.current.scrollLeft = img.offsetLeft + img.offsetWidth * relX - (point.x - rect.left);
      viewport.current.scrollTop = img.offsetTop + img.offsetHeight * relY - (point.y - rect.top);
    });
  }
  function step(direction: 1 | -1) {
    const current = zoom ?? fitScale();
    const next = direction > 0 ? STEPS.find((value) => value > current + 0.001) : [...STEPS].reverse().find((value) => value < current - 0.001);
    if (next !== undefined) applyZoom(next);
    else if (direction < 0) applyZoom(null);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frame.current?.requestFullscreen().catch(() => {});
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !viewport.current) return;
    drag.current = { x: event.clientX, y: event.clientY, left: viewport.current.scrollLeft, top: viewport.current.scrollTop, moved: false };
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || zoom === null || !viewport.current) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    if (!start.moved) viewport.current.setPointerCapture(event.pointerId);
    start.moved = true;
    viewport.current.scrollLeft = start.left - dx;
    viewport.current.scrollTop = start.top - dy;
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    drag.current = null;
    if (!start || start.moved || event.target !== image.current) return;
    // A click (not a drag) toggles between fitting the view and actual pixels.
    if (zoom === null) { if (fitScale() < 0.999) applyZoom(1, { x: event.clientX, y: event.clientY }); }
    else applyZoom(null);
  }

  const percent = zoom === null ? null : Math.round(zoom * 100);
  const canZoomIn = natural !== null && (zoom ?? 0) < STEPS[STEPS.length - 1];
  return <div ref={frame} className={cn("flex w-full flex-col bg-background", fullscreen && "h-full")}>
    <div ref={viewport} tabIndex={0} role="region" aria-label={`${alt}. Use plus and minus to zoom, 0 to fit.`}
      onKeyDown={(event) => {
        if (event.key === "+" || event.key === "=") { event.preventDefault(); step(1); }
        else if (event.key === "-") { event.preventDefault(); step(-1); }
        else if (event.key === "0") { event.preventDefault(); applyZoom(null); }
      }}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { drag.current = null; }}
      className={cn("image-canvas relative grid w-full overflow-auto overscroll-contain p-4 outline-none [place-items:safe_center] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-8",
        fullscreen ? "flex-1" : "h-[min(72dvh,780px)] min-h-64",
        zoom !== null && "cursor-grab active:cursor-grabbing")}>
      {!natural && <Skeleton className="absolute inset-6 rounded-lg sm:inset-10" />}
      {/* Signed, short-lived storage URLs must not pass through Next's image optimizer cache. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={image} src={src} alt={alt} draggable={false}
        onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={onError}
        style={zoom === null || !natural ? undefined : { width: natural.width * zoom, height: natural.height * zoom, maxWidth: "none", maxHeight: "none" }}
        className={cn("block select-none shadow-[0_1px_2px_rgb(0_0_0/.08),0_8px_24px_rgb(0_0_0/.08)]",
          zoom === null && "max-h-full max-w-full object-contain",
          zoom === null && natural && "cursor-zoom-in",
          !natural && "opacity-0")} />
    </div>
    <div className="flex min-h-11 items-center gap-1 border-t border-border/70 px-2 sm:px-3">
      <span className="px-1.5 text-xs tabular-nums text-muted-foreground">{natural ? `${natural.width.toLocaleString()} × ${natural.height.toLocaleString()} px` : "Loading image…"}</span>
      <div className="ml-auto flex items-center gap-0.5">
        <Hint label="Zoom out (−)"><Button variant="ghost" size="icon-sm" aria-label="Zoom out" disabled={!natural || zoom === null} onClick={() => step(-1)}><ZoomOut /></Button></Hint>
        <Hint label={percent === null ? "Show actual size" : "Fit to view (0)"}><Button variant="ghost" size="sm" className="min-w-14 tabular-nums" disabled={!natural} aria-label={percent === null ? "Fitted to view. Show actual size" : `Zoom ${percent}%. Fit to view`} onClick={() => applyZoom(zoom === null ? 1 : null)}>{percent === null ? "Fit" : `${percent}%`}</Button></Hint>
        <Hint label="Zoom in (+)"><Button variant="ghost" size="icon-sm" aria-label="Zoom in" disabled={!canZoomIn} onClick={() => step(1)}><ZoomIn /></Button></Hint>
        <Hint label={fullscreen ? "Exit full screen" : "Full screen"}><Button variant="ghost" size="icon-sm" aria-label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>{fullscreen ? <Minimize /> : <Maximize />}</Button></Hint>
      </div>
    </div>
  </div>;
}
