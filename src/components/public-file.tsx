"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Code2, Copy, Download, File, FileImage, FileMusic, FileText, FileVideo, Link2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { getPublicAccess } from "@/app/actions/public";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/spinner";
import type { DriveItem } from "@/lib/drive-types";
import { PdfPreview } from "@/components/pdf-preview";
import { getPreviewKind, type PreviewKind } from "@/lib/file-preview";
import { languageFor } from "@/lib/syntax-highlight";
import { TextPreview } from "@/components/text-preview";
import { ImageViewer } from "@/components/image-viewer";
import { AudioPlayer, VideoPlayer, type PlaybackState } from "@/components/media-player";
import { FileScanBadge } from "@/components/file-scan-badge";

const EMBEDDABLE_KINDS: Record<string, true> = { image: true, video: true, pdf: true };
const KIND_ICONS = { image: FileImage, video: FileVideo, audio: FileMusic, pdf: FileText, text: FileText } as const;
const KIND_NOUNS: Record<PreviewKind, string> = { image: "image", video: "video", audio: "audio", pdf: "document", text: "text file" };

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${units[unit - 1]}`;
}

function describeType(name: string, kind: PreviewKind | null) {
  const language = kind === "text" ? languageFor(name) : null;
  if (language) return language.name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
  if (kind === "pdf") return "PDF document";
  if (kind) return extension ? `${extension} ${KIND_NOUNS[kind]}` : KIND_NOUNS[kind];
  return extension ? `${extension} file` : "File";
}

export function PublicFile({ item, token, previewUrl: initialPreview, sharedByEmail }: {
  item: DriveItem; token: string; previewUrl: string | null; sharedByEmail: string | null;
}) {
  const [previewUrl, setPreviewUrl] = useState(initialPreview);
  const [previewError, setPreviewError] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [linkCopied, setLinkCopied] = useState(false);
  const [resume, setResume] = useState<PlaybackState>();
  const lastRefresh = useRef(0);
  const kind = getPreviewKind(item);
  const Icon = kind ? KIND_ICONS[kind] : File;

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
  // Preview URLs expire within a minute; a failed media request fetches a fresh one and resumes in place.
  function mediaFailed(state: PlaybackState) {
    setResume(state);
    if (access.isPending) return;
    // A URL that fails right after refreshing is a real failure, not expiry; stop instead of looping.
    if (Date.now() - lastRefresh.current < 15_000) return setPreviewError(true);
    lastRefresh.current = Date.now();
    access.mutate("preview");
  }

  const embeddable = kind !== null && EMBEDDABLE_KINDS[kind] === true;
  async function copy(value: string, done: string, failed: string) {
    try { await navigator.clipboard.writeText(value); toast.success(done); return true; }
    catch { toast.error(failed); return false; }
  }
  async function copyLink() {
    if (await copy(window.location.href, "Link copied", "Could not copy the link. Copy it from the address bar.")) {
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1600);
    }
  }
  const embedSnippet = () => `<iframe src="${window.location.origin}/s/${token}/embed" title="${item.name.replace(/"/g, "&quot;")}" loading="lazy" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0;"></iframe>`;

  const unavailable = !previewUrl || !kind || previewError;
  return <article className="flex w-full flex-col gap-6">
    <header className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="size-6" strokeWidth={1.6} /></span>
        <div className="min-w-0">
          <h1 className="wrap-anywhere text-xl font-semibold tracking-[-0.02em] text-balance sm:text-2xl">{item.name}</h1>
          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <div><dt className="sr-only">Type</dt><dd>{describeType(item.name, kind)}</dd></div>
            <div><dt className="sr-only">Size</dt><dd className="tabular-nums">{formatSize(item.size)}</dd></div>
            {sharedByEmail && <div className="min-w-0"><dt className="inline">Shared by </dt><dd className="inline wrap-anywhere text-foreground">{sharedByEmail}</dd></div>}
          </dl>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="outline" onClick={copyLink}>{linkCopied ? <Check data-icon="inline-start" /> : <Link2 data-icon="inline-start" />}Copy link</Button>
        {embeddable && <Popover>
          <PopoverTrigger render={<Button variant="outline" />}><Code2 data-icon="inline-start" />Embed</PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <PopoverHeader>
              <PopoverTitle>Embed this file</PopoverTitle>
              <PopoverDescription>Paste the code into any page that allows iframes. It stops working if the link is revoked.</PopoverDescription>
            </PopoverHeader>
            <Button onClick={() => void copy(embedSnippet(), "Embed code copied", "Could not copy the embed code.")}><Copy data-icon="inline-start" />Copy embed code</Button>
          </PopoverContent>
        </Popover>}
        <Button disabled={access.isPending && access.variables === "download"} onClick={() => access.mutate("download")}>
          {access.isPending && access.variables === "download" ? <Spinner label="Preparing download" /> : <Download data-icon="inline-start" />}Download
        </Button>
      </div>
    </header>

    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[var(--surface-shadow)]">
      {unavailable ? <div className="flex min-h-72 flex-col items-center justify-center gap-4 px-6 py-14 text-center">
        <span aria-hidden="true" className="flex size-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><Icon className="size-8" strokeWidth={1.4} /></span>
        <div>
          <p className="font-medium">{previewError ? "The preview didn’t load" : "No preview for this file type"}</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{previewError ? "The link may have been updated. Reload the preview, or download the file." : "Download the file to open it on your device."}</p>
        </div>
        {previewError ? <Button variant="outline" onClick={() => access.mutate("preview")} disabled={access.isPending}>{access.isPending ? <Spinner /> : <RefreshCw data-icon="inline-start" />}Reload preview</Button>
          : <Button onClick={() => access.mutate("download")} disabled={access.isPending}><Download data-icon="inline-start" />Download {formatSize(item.size)}</Button>}
      </div>
      : kind === "text" ? <TextPreview key={previewVersion} url={previewUrl} name={item.name} size={item.size} onReload={() => access.mutate("preview")} isReloading={access.isPending} />
      : kind === "image" ? <ImageViewer key={previewVersion} src={previewUrl} alt={item.name} onError={() => setPreviewError(true)} />
      : kind === "video" ? <VideoPlayer key={previewVersion} src={previewUrl} title={item.name} resume={resume} onFailure={mediaFailed} />
      : kind === "audio" ? <AudioPlayer key={previewVersion} src={previewUrl} title={item.name} detail={`${describeType(item.name, kind)}, ${formatSize(item.size)}`} resume={resume} onFailure={mediaFailed} />
      : <div className="flex max-h-[80dvh] min-h-72 justify-center overflow-auto bg-muted/50 p-4 sm:p-6"><PdfPreview key={previewVersion} url={previewUrl} name={item.name} onError={() => setPreviewError(true)} /></div>}
    </div>

    {access.isError && <p role="alert" className="text-sm text-destructive">{access.error.message}</p>}
    <FileScanBadge token={token} />
  </article>;
}
