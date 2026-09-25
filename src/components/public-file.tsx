"use client";

import { useRef, useState, type SyntheticEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Code2, Download, File, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { getPublicAccess } from "@/app/actions/public";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/spinner";
import type { DriveItem } from "@/lib/drive-types";
import { PdfPreview } from "@/components/pdf-preview";
import { getPreviewKind } from "@/lib/file-preview";
import { TextPreview } from "@/components/text-preview";
import { FileScanBadge } from "@/components/file-scan-badge";

const EMBEDDABLE_KINDS: Record<string, true> = { image: true, video: true, pdf: true };

export function PublicFile({ item, token, previewUrl: initialPreview }: { item: DriveItem; token: string; previewUrl: string | null }) {
  const [previewUrl, setPreviewUrl] = useState(initialPreview);
  const [previewError, setPreviewError] = useState(false);
  const kind = getPreviewKind(item);
  const [previewVersion, setPreviewVersion] = useState(0);
  const playback = useRef({ time: 0, paused: true });
  function mediaError(event: SyntheticEvent<HTMLMediaElement>) {
    playback.current.time = event.currentTarget.currentTime;
    setPreviewError(true);
  }
  function restorePlayback(event: SyntheticEvent<HTMLMediaElement>) {
    event.currentTarget.currentTime = playback.current.time;
    if (!playback.current.paused) void event.currentTarget.play().catch(() => {});
  }
  const access = useMutation({
    mutationFn: async (intent: "download" | "preview") => {
      const result = await getPublicAccess(token);
      if (!result.success) throw new Error(result.error);
      return { ...result.data, intent };
    },
    onSuccess: ({ downloadUrl, previewUrl, intent }) => {
      if (intent === "download") window.location.assign(downloadUrl);
      else { setPreviewError(false); setPreviewUrl(previewUrl); setPreviewVersion((version) => version + 1); }
    },
  });
  const embeddable = kind !== null && EMBEDDABLE_KINDS[kind] === true;
  const embedPath = `/s/${token}/embed`;
  async function copyEmbedSnippet() {
    const snippet = `<iframe src="${window.location.origin}${embedPath}" title="${item.name.replace(/"/g, "'")}" loading="lazy" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0;"></iframe>`;
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success("Embed code copied");
    } catch {
      toast.error("Could not copy the embed code. Select it below and copy manually.");
    }
  }
  return <div className="flex w-full flex-col gap-6">
    <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-2xl bg-muted p-4 sm:min-h-80 sm:p-8">
      {!previewUrl || !kind || previewError ? <div className="flex flex-col items-center gap-4 text-center">
        <File className="size-14 text-muted-foreground" strokeWidth={1.2} aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{previewError ? "The preview couldn’t load." : "Download this file to open it."}</p>
        {previewError && <Button variant="outline" onClick={() => access.mutate("preview")} disabled={access.isPending}><RefreshCw data-icon="inline-start" />Reload preview</Button>}
      </div> : kind === "text" ? <TextPreview key={previewVersion} url={previewUrl} name={item.name} size={item.size} onReload={() => access.mutate("preview")} isReloading={access.isPending} />
      : kind === "image" ?
        // Signed, short-lived R2 URLs must not be cached by Next's image optimizer.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt={item.name} className="max-h-[60dvh] max-w-full rounded-lg object-contain" onError={() => setPreviewError(true)} />
      : kind === "video" ? <video src={previewUrl} controls playsInline preload="metadata" className="max-h-[60dvh] w-full" onError={mediaError} onLoadedMetadata={restorePlayback} onPlay={() => { playback.current.paused = false; }} onPause={(event) => { if (!event.currentTarget.error) playback.current.paused = true; }} aria-label={item.name} />
      : kind === "audio" ? <audio src={previewUrl} controls preload="metadata" className="w-full" onError={mediaError} onLoadedMetadata={restorePlayback} onPlay={() => { playback.current.paused = false; }} onPause={(event) => { if (!event.currentTarget.error) playback.current.paused = true; }} aria-label={item.name} />
      : kind === "pdf" ? <PdfPreview url={previewUrl} name={item.name} onError={() => setPreviewError(true)} /> : null}
    </div>
    <div className="flex flex-col items-center gap-3">
      <FileScanBadge token={token} />
      <Button size="lg" disabled={access.isPending} onClick={() => access.mutate("download")}>
        {access.isPending ? <Spinner label="Preparing download" /> : <Download data-icon="inline-start" />}Download file
      </Button>
      {access.isError && <p role="alert" className="max-w-md text-center text-sm text-destructive">{access.error.message}</p>}
      {embeddable && <div className="flex w-full max-w-sm flex-col items-center gap-2">
        <div className="flex w-full gap-2">
          <Input readOnly value={embedPath} onFocus={(event) => event.target.select()} aria-label="Embed URL path" className="text-xs" />
          <Button type="button" variant="outline" size="icon" onClick={copyEmbedSnippet} aria-label="Copy embed code"><Code2 /></Button>
        </div>
        <p className="text-center text-xs text-muted-foreground">Copy an iframe snippet to embed this file elsewhere.</p>
      </div>}
    </div>
  </div>;
}
