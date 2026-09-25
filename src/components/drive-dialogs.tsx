"use client";

import { useRef, useState, type SyntheticEvent } from "react";
import Image from "next/image";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, Globe2, Link2, Link2Off, LockKeyhole, QrCode, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { createFolder, getDownloadUrl, getPreviewUrl, renameItem, setPublic } from "@/app/actions/drive";
import type { DriveItem } from "@/lib/drive-types";
import { cn } from "@/lib/utils";
import { getPreviewKind } from "@/lib/file-preview";
import { optimisticDriveChange } from "@/lib/drive-cache";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/spinner";
import { DriveFileIcon, fileType } from "@/components/drive-item";
import { formatBytes } from "@/lib/format-bytes";
import { PdfPreview } from "@/components/pdf-preview";
import { TextPreview } from "@/components/text-preview";
import { ShareQr } from "@/components/share-qr";
import { ScanStatusLine } from "@/components/file-scan-badge";
import { useFolderAccess } from "@/components/folder-access";
import { Hint, TruncatedText } from "@/components/hint";

export function useDriveDownload() {
  const { run } = useFolderAccess();
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await run(() => getDownloadUrl(id));
      return result.url;
    },
    onSuccess: (url) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "";
      anchor.rel = "noopener";
      anchor.click();
    },
    onError: (error) => toast.error(error.message),
  });
}

export function DriveNameDialog({ item, parentId, onClose }: { item?: DriveItem; parentId: string | null; onClose: () => void }) {
  const [name, setName] = useState(item?.name ?? "");
  const queryClient = useQueryClient();
  const { run } = useFolderAccess();
  const mutation = useMutation({
    mutationFn: async () => {
      if (item) await run(() => renameItem({ id: item.id, name: name.trim() }));
      else await run(() => createFolder({ name: name.trim(), parentId }));
    },
    onMutate: async () => item ? { rollback: await optimisticDriveChange(queryClient, { kind: "rename", id: item.id, name: name.trim() }) } : undefined,
    onError: (_error, _variables, context) => context?.rollback(),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["drive"] }); },
    onSuccess: () => {
      toast.success(item ? "Name updated" : "Folder created");
      onClose();
    },
  });
  return <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent showCloseButton={!mutation.isPending}>
      <form onSubmit={(event) => { event.preventDefault(); if (name.trim() && !mutation.isPending) mutation.mutate(); }} className="flex flex-col gap-6">
        <DialogHeader>
          <DialogTitle>{item ? "Rename" : "New folder"}</DialogTitle>
          <DialogDescription>{item ? "Choose a name that is easy to find." : "Give your family’s files a place of their own."}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-invalid={Boolean(mutation.error)}>
            <FieldLabel htmlFor="drive-item-name">{item ? "Name" : "Folder name"}</FieldLabel>
            <Input id="drive-item-name" value={name} onChange={(event) => { setName(event.target.value); mutation.reset(); }} required maxLength={255} autoFocus autoComplete="off" disabled={mutation.isPending} aria-invalid={Boolean(mutation.error)} aria-describedby={mutation.error ? "drive-name-error" : undefined} onFocus={(event) => event.target.select()} />
            {mutation.error && <FieldError id="drive-name-error" role="alert">{mutation.error.message}</FieldError>}
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button type="submit" disabled={!name.trim() || mutation.isPending}>{mutation.isPending && <Spinner />}{item ? "Save name" : "Create folder"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

const EXPIRY_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "86400", label: "In 1 day" },
  { value: "604800", label: "In 7 days" },
  { value: "2592000", label: "In 30 days" },
];

export function DriveShareDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { run } = useFolderAccess();
  const folder = item.kind === "folder";
  const noun = folder ? "folder" : "file";
  const [url, setUrl] = useState<string | null>(item.publicToken ? `${window.location.origin}/s/${item.publicToken}` : null);
  const [expiresAt, setExpiresAt] = useState(item.publicExpiresAt);
  // "current" stands for the active link's own expiry; other values are choices applied on create or change.
  const [expiry, setExpiry] = useState(item.publicExpiresAt ? "current" : "never");
  const expiryItems = expiresAt ? [{ value: "current", label: `Until ${new Date(expiresAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}` }, ...EXPIRY_OPTIONS] : EXPIRY_OPTIONS;
  const mutation = useMutation({
    mutationFn: ({ enabled, choice }: { enabled: boolean; choice?: string }) =>
      run(() => setPublic({ id: item.id, enabled, expiresIn: choice === undefined || choice === "current" ? undefined : choice === "never" ? null : Number(choice) })),
    onSuccess: (result, { enabled }) => {
      toast.success(!enabled ? "Public link revoked" : url ? "Link expiry updated" : "Public link created");
      setUrl(result.url);
      setExpiresAt(result.expiresAt);
      setExpiry(result.expiresAt ? "current" : "never");
      void queryClient.invalidateQueries({ queryKey: ["drive"] });
      if (!folder) void queryClient.invalidateQueries({ queryKey: ["private-file-scan", item.id] });
    },
  });
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  async function copyLink() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy the link. Select the link and copy it manually.");
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent className="gap-5 sm:max-w-md" showCloseButton={!mutation.isPending}>
      <DialogHeader>
        <DialogTitle>{folder ? "Share folder" : "Share file"}</DialogTitle>
        <DialogDescription render={<TruncatedText as="p">{item.name}</TruncatedText>} />
      </DialogHeader>
      <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/30 p-3">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", url ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>{url ? <Globe2 className="size-4" /> : <LockKeyhole className="size-4" />}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium">{url ? "Anyone with the link" : "Family only"}</p>
          <p className="text-xs text-muted-foreground">{url ? "Can view and download without signing in." : item.isProtected ? (folder ? "Password-protected folders, and folders inside them, can’t be shared publicly." : "Files in a protected folder can’t be shared publicly.") : `Only verified family members can open this ${noun}.`}</p>
        </div>
      </div>
      {folder && !item.isProtected && <p className="text-xs text-muted-foreground">Anyone with the link can browse, preview and download everything inside this folder, including files added later. Password-protected subfolders and their contents stay hidden.</p>}
      {!item.isProtected && <div className="flex items-center justify-between gap-3">
        <p id="share-expiry-label" className="text-sm">Link expires</p>
        <Select value={expiry} items={expiryItems} disabled={mutation.isPending} onValueChange={(value) => { if (!value) return; if (url) mutation.mutate({ enabled: true, choice: value }); else setExpiry(value); }}>
          <SelectTrigger size="sm" aria-labelledby="share-expiry-label" className="w-auto"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>{expiryItems.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </div>}
      {url && <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Input id="public-link" aria-label="Public link" value={url} readOnly onFocus={(event) => event.target.select()} className="font-mono text-xs" />
          <Button onClick={copyLink} className="w-24 shrink-0">{copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}{copied ? "Copied" : "Copy"}</Button>
        </div>
        <Button variant="ghost" size="sm" className="self-start text-muted-foreground" aria-expanded={showQr} onClick={() => setShowQr((open) => !open)}>
          <QrCode data-icon="inline-start" />{showQr ? "Hide QR code" : "Show QR code"}
        </Button>
        {showQr && <ShareQr url={url} />}
        {!folder && <ScanStatusLine itemId={item.id} />}
      </div>}
      {!url && !item.isProtected && <p className="text-xs text-muted-foreground">{folder ? "" : "Creating a link also sends the file to VirusTotal to scan it for viruses. "}Your verified email appears on the public page, and you can revoke the link at any time.</p>}
      {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
      <DialogFooter className="sm:justify-between">
        {url
          ? <Hint label="Stops new visits immediately. Copies already downloaded can’t be recalled."><Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate({ enabled: false })}>{mutation.isPending ? <Spinner /> : <Link2Off data-icon="inline-start" />}Revoke link</Button></Hint>
          : <Button disabled={mutation.isPending || item.isProtected} onClick={() => mutation.mutate({ enabled: true, choice: expiry })}>{mutation.isPending ? <Spinner /> : <Link2 data-icon="inline-start" />}Create public link</Button>}
        <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Done</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function DrivePreviewDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const download = useDriveDownload();
  const { run } = useFolderAccess();
  const [mediaError, setMediaError] = useState(false);
  const playback = useRef({ time: 0, paused: true });
  const kind = getPreviewKind(item);
  const preview = useQuery({
    queryKey: ["drive-preview", item.id, item.name],
    queryFn: async ({ signal }) => {
      const result = await run(() => getPreviewUrl(item.id));
      signal.throwIfAborted();
      return result.url;
    },
    enabled: kind !== null,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const url = preview.data;
  function rememberPlayback(event: SyntheticEvent<HTMLMediaElement>) {
    playback.current.time = event.currentTarget.currentTime;
    setMediaError(true);
  }
  function restorePlayback(event: SyntheticEvent<HTMLMediaElement>) {
    const media = event.currentTarget;
    if (playback.current.time > 0) media.currentTime = playback.current.time;
    if (!playback.current.paused) void media.play().catch(() => toast.info("Press play to resume the preview."));
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader className="pr-7">
        <Hint label={item.name}><DialogTitle className="truncate">{item.name}</DialogTitle></Hint>
        <DialogDescription>{fileType(item)} · {formatBytes(item.size)}</DialogDescription>
      </DialogHeader>
      <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-xl bg-muted/50">
        {kind && preview.isPending ? <div role="status" className="flex items-center gap-2 py-24 text-sm text-muted-foreground"><Spinner />Loading preview…</div>
          : preview.error ? <Alert variant="destructive" className="m-6"><TriangleAlert /><AlertTitle>Preview could not load</AlertTitle><AlertDescription>{preview.error.message}<Button variant="outline" size="sm" onClick={() => void preview.refetch()}>Try again</Button></AlertDescription></Alert>
          : !url || !kind || mediaError ? <div className="flex flex-col items-center gap-2 px-6 py-12 text-center"><DriveFileIcon item={item} large /><p className="mt-3 text-sm font-medium">{mediaError ? "This preview could not be displayed" : "No preview for this file type"}</p><p className="text-sm text-muted-foreground">Download the file to open it on your device.</p>{mediaError && <Button variant="outline" size="sm" disabled={preview.isFetching} onClick={async () => { const refreshed = await preview.refetch(); if (refreshed.isSuccess) setMediaError(false); }}>{preview.isFetching && <Spinner />}Reload preview</Button>}</div>
          : kind === "text" ? <TextPreview key={preview.dataUpdatedAt} url={url} name={item.name} size={item.size} onReload={() => { void preview.refetch(); }} isReloading={preview.isFetching} />
          : kind === "image" ? <Image src={url} alt={item.name} width={1200} height={800} unoptimized className="max-h-[60dvh] w-auto max-w-full object-contain" onError={() => setMediaError(true)} />
          : kind === "video" ? <video src={url} controls playsInline preload="metadata" className="max-h-[60dvh] w-full" aria-label={item.name} onError={rememberPlayback} onLoadedMetadata={restorePlayback} onPlay={() => { playback.current.paused = false; }} onPause={(event) => { if (!event.currentTarget.error) playback.current.paused = true; }} />
          : kind === "audio" ? <div className="flex w-full flex-col items-center gap-8 p-8"><DriveFileIcon item={item} large /><audio src={url} controls preload="metadata" className="w-full" aria-label={item.name} onError={rememberPlayback} onLoadedMetadata={restorePlayback} onPlay={() => { playback.current.paused = false; }} onPause={(event) => { if (!event.currentTarget.error) playback.current.paused = true; }} /></div>
          : kind === "pdf" ? <PdfPreview url={url} name={item.name} onError={() => setMediaError(true)} /> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Close</Button>
        <Button onClick={() => download.mutate(item.id)} disabled={download.isPending}>{download.isPending ? <Spinner /> : <Download data-icon="inline-start" />}Download</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
