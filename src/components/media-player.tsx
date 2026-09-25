"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import { Slider } from "@base-ui/react/slider";
import { Maximize, Minimize, Music, Pause, PictureInPicture2, Play, RotateCcw, RotateCw, Volume1, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/spinner";

export type PlaybackState = { time: number; paused: boolean };
type Tone = "overlay" | "surface";

const RATES = [1, 1.25, 1.5, 2, 0.5, 0.75];

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function ControlButton({ tone, label, onClick, children, className, pressed }: {
  tone: Tone; label: string; onClick: () => void; children: ReactNode; className?: string; pressed?: boolean;
}) {
  return <button type="button" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick} className={cn(
    "inline-flex size-9 shrink-0 items-center justify-center rounded-lg outline-none transition-colors [&_svg]:size-[18px] focus-visible:ring-2",
    tone === "overlay" ? "text-white hover:bg-white/15 focus-visible:ring-white/80" : "text-foreground hover:bg-muted focus-visible:ring-ring",
    className,
  )}>{children}</button>;
}

/** A thin track that thickens on interaction, with a buffered-range layer the native element doesn't expose. */
function MediaSlider({ tone, value, max, buffered, label, valueText, onChange, onCommit, className }: {
  tone: Tone; value: number; max: number; buffered?: number; label: string; valueText: (value: number) => string;
  onChange: (value: number) => void; onCommit?: (value: number) => void; className?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  return <Slider.Root value={Math.min(value, safeMax)} min={0} max={safeMax} step={safeMax / 1000} onValueChange={(next) => onChange(next as number)} onValueCommitted={(next) => onCommit?.(next as number)} className={cn("group/slider relative flex h-5 w-full touch-none items-center", className)}>
    <Slider.Control className="flex h-5 w-full cursor-pointer items-center">
      <Slider.Track className={cn("relative h-1 w-full overflow-visible rounded-full transition-[height] duration-150 group-hover/slider:h-1.5 group-data-dragging/slider:h-1.5", tone === "overlay" ? "bg-white/25" : "bg-foreground/12")}>
        {buffered !== undefined && <div aria-hidden="true" className={cn("absolute inset-y-0 left-0 rounded-full", tone === "overlay" ? "bg-white/35" : "bg-foreground/15")} style={{ width: `${Math.min(100, (buffered / safeMax) * 100)}%` }} />}
        <Slider.Indicator className={cn("absolute h-full rounded-full", tone === "overlay" ? "bg-white" : "bg-primary")} />
        <Slider.Thumb getAriaLabel={() => label} getAriaValueText={(_formatted, current) => valueText(current)} className={cn(
          "size-3.5 rounded-full shadow-[0_1px_3px_rgb(0_0_0/.35)] outline-none transition-transform duration-150",
          "scale-0 group-hover/slider:scale-100 group-data-dragging/slider:scale-100 has-[:focus-visible]:scale-100 has-[:focus-visible]:ring-2",
          tone === "overlay" ? "bg-white has-[:focus-visible]:ring-white/80" : "bg-primary has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background",
        )} />
      </Slider.Track>
    </Slider.Control>
  </Slider.Root>;
}

// The element ref stays with the component; the returned state never contains it, so render stays ref-free.
function useMediaState(ref: RefObject<HTMLMediaElement | null>, resume: PlaybackState | undefined, onFailure: (state: PlaybackState) => void) {
  const wasPlaying = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(Boolean(resume && resume.time > 0));
  const [ended, setEnded] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(resume?.time ?? 0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);

  function readBuffered(media: HTMLMediaElement) {
    const ranges = media.buffered;
    for (let index = 0; index < ranges.length; index++) {
      if (ranges.start(index) <= media.currentTime && media.currentTime <= ranges.end(index)) return setBuffered(ranges.end(index));
    }
    setBuffered(ranges.length ? ranges.end(ranges.length - 1) : 0);
  }

  const events = {
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => {
      const media = event.currentTarget;
      setDuration(media.duration);
      // A refreshed short-lived URL resumes where the expired one stopped.
      if (resume && resume.time > 0) media.currentTime = resume.time;
      if (resume && !resume.paused) void media.play().catch(() => {});
    },
    onDurationChange: (event: SyntheticEvent<HTMLMediaElement>) => setDuration(event.currentTarget.duration),
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => { setTime(event.currentTarget.currentTime); readBuffered(event.currentTarget); },
    onProgress: (event: SyntheticEvent<HTMLMediaElement>) => readBuffered(event.currentTarget),
    onPlay: () => { wasPlaying.current = true; setPlaying(true); setStarted(true); setEnded(false); },
    onPause: (event: SyntheticEvent<HTMLMediaElement>) => { if (!event.currentTarget.error) wasPlaying.current = false; setPlaying(false); },
    onWaiting: () => setWaiting(true),
    onPlaying: () => setWaiting(false),
    onCanPlay: () => setWaiting(false),
    onEnded: () => { setEnded(true); setPlaying(false); },
    onVolumeChange: (event: SyntheticEvent<HTMLMediaElement>) => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted); },
    onRateChange: (event: SyntheticEvent<HTMLMediaElement>) => setRate(event.currentTarget.playbackRate),
    onError: (event: SyntheticEvent<HTMLMediaElement>) => onFailure({ time: event.currentTarget.currentTime, paused: !wasPlaying.current }),
  };

  const media = () => ref.current;
  const controls = {
    toggle() { const el = media(); if (!el) return; if (el.paused || el.ended) void el.play().catch(() => {}); else el.pause(); },
    seekBy(delta: number) { const el = media(); if (el) el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + delta)); },
    seekTo(value: number) { const el = media(); if (el) { el.currentTime = value; setTime(value); } setScrub(null); },
    setVolume(value: number) { const el = media(); if (!el) return; el.volume = value; el.muted = value === 0; },
    toggleMute() { const el = media(); if (!el) return; if (el.muted || el.volume === 0) { el.muted = false; if (el.volume === 0) el.volume = 0.6; } else el.muted = true; },
    cycleRate() { const el = media(); if (el) el.playbackRate = RATES[(RATES.indexOf(el.playbackRate) + 1) % RATES.length] ?? 1; },
    setScrub,
  };
  const shownTime = scrub ?? time;
  const level = muted ? 0 : volume;
  return { events, controls, playing, started, ended, waiting, shownTime, duration, buffered, level, rate };
}

function shortcut(event: KeyboardEvent<HTMLElement>, player: ReturnType<typeof useMediaState>, fullscreen?: () => void) {
  const target = event.target as HTMLElement;
  if (event.metaKey || event.ctrlKey || event.altKey || target.closest("button, input")) return;
  const handlers: Record<string, () => void> = {
    " ": player.controls.toggle, k: player.controls.toggle,
    ArrowLeft: () => player.controls.seekBy(-5), ArrowRight: () => player.controls.seekBy(5),
    j: () => player.controls.seekBy(-10), l: () => player.controls.seekBy(10),
    ArrowUp: () => player.controls.setVolume(Math.min(1, player.level + 0.1)), ArrowDown: () => player.controls.setVolume(Math.max(0, player.level - 0.1)),
    m: player.controls.toggleMute,
    ...(fullscreen ? { f: fullscreen } : {}),
  };
  const handler = handlers[event.key.length === 1 ? event.key.toLowerCase() : event.key];
  if (!handler) return;
  event.preventDefault();
  handler();
}

function VolumeControl({ tone, player }: { tone: Tone; player: ReturnType<typeof useMediaState> }) {
  const Icon = player.level === 0 ? VolumeX : player.level < 0.5 ? Volume1 : Volume2;
  return <div className="group/volume flex items-center">
    <ControlButton tone={tone} label={player.level === 0 ? "Unmute" : "Mute"} onClick={player.controls.toggleMute}><Icon /></ControlButton>
    <div className="hidden w-0 overflow-hidden opacity-0 transition-[width,opacity] duration-200 group-hover/volume:w-20 group-hover/volume:opacity-100 group-focus-within/volume:w-20 group-focus-within/volume:opacity-100 sm:block">
      <MediaSlider tone={tone} className="mx-2 w-16" value={player.level} max={1} label="Volume" valueText={(value) => `${Math.round(value * 100)}%`} onChange={player.controls.setVolume} />
    </div>
  </div>;
}

function RateButton({ tone, player }: { tone: Tone; player: ReturnType<typeof useMediaState> }) {
  return <button type="button" onClick={player.controls.cycleRate} aria-label={`Playback speed ${player.rate}×. Change speed`} title="Playback speed" className={cn(
    "inline-flex h-9 min-w-11 shrink-0 items-center justify-center rounded-lg px-2 text-xs font-semibold tabular-nums outline-none transition-colors focus-visible:ring-2",
    tone === "overlay" ? "text-white hover:bg-white/15 focus-visible:ring-white/80" : "text-foreground hover:bg-muted focus-visible:ring-ring",
  )}>{player.rate}×</button>;
}

export function VideoPlayer({ src, title, resume, onFailure }: { src: string; title: string; resume?: PlaybackState; onFailure: (state: PlaybackState) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const player = useMediaState(video, resume, onFailure);
  const container = useRef<HTMLDivElement>(null);
  const idle = useRef<number | undefined>(undefined);
  const [active, setActive] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);

  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", change);
    return () => { document.removeEventListener("fullscreenchange", change); window.clearTimeout(idle.current); };
  }, []);

  function wake() {
    setActive(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setActive(false), 2500);
  }
  function toggleFullscreen() {
    const element = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (container.current?.requestFullscreen) void container.current.requestFullscreen().catch(() => {});
    else element?.webkitEnterFullscreen?.();
  }
  async function togglePip() {
    const element = video.current;
    if (!element) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await element.requestPictureInPicture();
    } catch { /* The browser declined; the inline player keeps working. */ }
  }

  const controlsShown = !player.playing || active;
  return <div ref={container} role="group" aria-label={`Video player: ${title}`} tabIndex={0}
    onKeyDown={(event) => { wake(); shortcut(event, player, toggleFullscreen); }}
    onPointerMove={wake} onPointerDown={wake} onFocus={wake}
    className={cn("group/player relative flex w-full items-center justify-center overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-ring", fullscreen ? "h-full" : "rounded-[inherit]", !controlsShown && "cursor-none")}>
    <video ref={video} src={src} playsInline preload="metadata" aria-label={title}
      onClick={player.controls.toggle} onDoubleClick={toggleFullscreen}
      onLoadedData={(event) => setPipSupported(document.pictureInPictureEnabled && !event.currentTarget.disablePictureInPicture)}
      className={cn("block w-full object-contain", fullscreen ? "h-full" : "max-h-[75dvh] min-h-56")} {...player.events} />

    {player.waiting && player.playing && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><Spinner size={36} label="Buffering" className="text-white" /></div>}
    {(!player.started || player.ended) && <button type="button" onClick={player.controls.toggle} aria-label={player.ended ? "Replay" : "Play"}
      className="absolute inset-0 m-auto flex size-16 items-center justify-center rounded-full bg-white/90 text-black shadow-[0_8px_30px_rgb(0_0_0/.35)] outline-none transition-transform duration-150 hover:scale-105 focus-visible:ring-4 focus-visible:ring-white/60 active:scale-95">
      {player.ended ? <RotateCcw className="size-7" /> : <Play className="ml-1 size-7 fill-current" />}
    </button>}

    <div data-shown={controlsShown} className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-linear-to-t from-black/75 via-black/35 to-transparent px-3 pb-2 pt-12 text-white opacity-0 transition-opacity duration-200 data-[shown=true]:opacity-100 group-focus-within/player:opacity-100 sm:px-4">
      <MediaSlider tone="overlay" value={player.shownTime} max={player.duration} buffered={player.buffered} label="Seek"
        valueText={(value) => `${formatTime(value)} of ${formatTime(player.duration)}`}
        onChange={player.controls.setScrub} onCommit={player.controls.seekTo} />
      <div className="flex items-center gap-0.5">
        <ControlButton tone="overlay" label={player.playing ? "Pause" : "Play"} onClick={player.controls.toggle}>{player.playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}</ControlButton>
        <ControlButton tone="overlay" label="Back 10 seconds" onClick={() => player.controls.seekBy(-10)} className="max-sm:hidden"><RotateCcw /></ControlButton>
        <ControlButton tone="overlay" label="Forward 10 seconds" onClick={() => player.controls.seekBy(10)} className="max-sm:hidden"><RotateCw /></ControlButton>
        <VolumeControl tone="overlay" player={player} />
        <span className="ml-1 text-xs tabular-nums text-white/90">{formatTime(player.shownTime)} <span className="text-white/55">/ {formatTime(player.duration)}</span></span>
        <div className="ml-auto flex items-center gap-0.5">
          <RateButton tone="overlay" player={player} />
          {pipSupported && <ControlButton tone="overlay" label="Picture in picture" onClick={togglePip} className="max-sm:hidden"><PictureInPicture2 /></ControlButton>}
          <ControlButton tone="overlay" label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>{fullscreen ? <Minimize /> : <Maximize />}</ControlButton>
        </div>
      </div>
    </div>
  </div>;
}

export function AudioPlayer({ src, title, detail, resume, onFailure }: { src: string; title: string; detail: string; resume?: PlaybackState; onFailure: (state: PlaybackState) => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const player = useMediaState(audio, resume, onFailure);
  const remaining = Math.max(0, player.duration - player.shownTime);
  return <div role="group" aria-label={`Audio player: ${title}`} tabIndex={0} onKeyDown={(event) => shortcut(event, player)}
    className="mx-auto flex w-full max-w-xl flex-col gap-5 rounded-2xl px-5 py-8 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-8 sm:py-10">
    {/* The element stays hidden: every control below drives it directly. */}
    <audio ref={audio} src={src} preload="metadata" aria-label={title} className="hidden" {...player.events} />
    <div className="flex items-center gap-4">
      <button type="button" onClick={player.controls.toggle} aria-label={player.playing ? "Pause" : player.ended ? "Replay" : "Play"}
        className="relative flex size-14 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_6px_20px_color-mix(in_oklab,var(--primary)_35%,transparent)] outline-none transition-transform duration-150 hover:scale-[1.04] focus-visible:ring-4 focus-visible:ring-ring/40 active:scale-95">
        {player.waiting && player.playing ? <Spinner size={22} label="Buffering" /> : player.playing ? <Pause className="size-6 fill-current" /> : player.ended ? <RotateCcw className="size-6" /> : <Play className="ml-0.5 size-6 fill-current" />}
      </button>
      <div className="min-w-0">
        <p className="truncate text-[15px] font-medium" title={title}>{title}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground"><Music className="size-3.5" aria-hidden="true" />{detail}</p>
      </div>
    </div>
    <div className="flex flex-col gap-1.5">
      <MediaSlider tone="surface" value={player.shownTime} max={player.duration} buffered={player.buffered} label="Seek"
        valueText={(value) => `${formatTime(value)} of ${formatTime(player.duration)}`}
        onChange={player.controls.setScrub} onCommit={player.controls.seekTo} />
      <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
        <span>{formatTime(player.shownTime)}</span>
        <span aria-label={`${formatTime(remaining)} remaining`}>-{formatTime(remaining)}</span>
      </div>
    </div>
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1">
        <ControlButton tone="surface" label="Back 15 seconds" onClick={() => player.controls.seekBy(-15)}><RotateCcw /></ControlButton>
        <ControlButton tone="surface" label="Forward 15 seconds" onClick={() => player.controls.seekBy(15)}><RotateCw /></ControlButton>
        <RateButton tone="surface" player={player} />
      </div>
      <VolumeControl tone="surface" player={player} />
    </div>
  </div>;
}
