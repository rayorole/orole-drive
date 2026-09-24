"use client";

import { useRef, useState, type SyntheticEvent } from "react";
import Image from "next/image";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, Globe2, Link2, LockKeyhole, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { createFolder, deleteItem, getDownloadUrl, getPreviewUrl, renameItem, setPublic } from "@/app/actions/drive";
import type { DriveItem } from "@/lib/drive-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/spinner";
import { DriveFileIcon, fileType, formatBytes } from "@/components/drive-item";
import { PdfPreview } from "@/components/pdf-preview";

export function useDriveDownload() {
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await getDownloadUrl(id);
      if (!result.success) throw new Error(result.error);
      return result.data.url;
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
  const mutation = useMutation({
    mutationFn: async () => {
      const result = item ? await renameItem({ id: item.id, name: name.trim() }) : await createFolder({ name: name.trim(), parentId });
      if (!result.success) throw new Error(result.error);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["drive"] });
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

export function DriveDeleteDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      const result = await deleteItem(item.id);
      if (!result.success) throw new Error(result.error);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["drive"] });
      toast.success(item.kind === "folder" ? "Folder deleted" : "File deleted");
      onClose();
    },
  });
  return <AlertDialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="break-words">Delete “{item.name}”?</AlertDialogTitle>
        <AlertDialogDescription>{item.kind === "folder" ? "This folder will be permanently deleted for the whole family. It must contain no files or folders. Any unfinished uploads inside it will be cancelled." : "This file will be permanently deleted for the whole family, and any public link will stop working."} This cannot be undone.</AlertDialogDescription>
      </AlertDialogHeader>
      {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={mutation.isPending}>Keep {item.kind}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending && <Spinner />}Delete {item.kind}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

export function DriveShareDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState<string | null>(item.publicToken ? `${window.location.origin}/s/${item.publicToken}` : null);
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const result = await setPublic({ id: item.id, enabled });
      if (!result.success) throw new Error(result.error);
      return result.data.url;
    },
    onSuccess: (nextUrl) => {
      setUrl(nextUrl);
      void queryClient.invalidateQueries({ queryKey: ["drive"] });
      toast.success(nextUrl ? "Public link created" : "Public link revoked");
    },
  });
  async function copyLink() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy the link. Select the link below and copy it manually.");
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent className="sm:max-w-md" showCloseButton={!mutation.isPending}>
      <DialogHeader>
        <DialogTitle>Share file</DialogTitle>
        <DialogDescription className="break-all">{item.name}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-3 py-2">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted">{url ? <Globe2 className="size-5 text-primary" /> : <LockKeyhole className="size-5 text-muted-foreground" />}</span>
        <div><p className="text-sm font-medium">{url ? "Anyone with the link" : "Only your family"}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{url ? "People outside your family can view and download this file. No sign-in needed." : "Only verified @orole.be family members can access this file."}</p></div>
      </div>
      {url ? <FieldGroup><Field>
        <FieldLabel htmlFor="public-file-link">Public link</FieldLabel>
        <div className="flex gap-2"><Input id="public-file-link" value={url} readOnly onFocus={(event) => event.target.select()} /><Button variant="outline" size="icon" onClick={copyLink} aria-label="Copy public link"><Copy /></Button></div>
      </Field></FieldGroup> : <p className="text-sm leading-relaxed text-muted-foreground">Create a public link to share this file outside your family. Your verified email will appear on the public page. You can revoke access here at any time.</p>}
      {url && <p className="text-xs leading-relaxed text-muted-foreground">Revoking blocks new visits immediately. Downloads already opened may remain available for up to one minute. Copies already downloaded cannot be recalled.</p>}
      {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Done</Button>
        <Button variant={url ? "destructive" : "default"} disabled={mutation.isPending} onClick={() => mutation.mutate(!url)}>{mutation.isPending ? <Spinner /> : <Link2 data-icon="inline-start" />}{url ? "Revoke link" : "Create public link"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function DrivePreviewDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const download = useDriveDownload();
  const [mediaError, setMediaError] = useState(false);
  const playback = useRef({ time: 0, paused: true });
  const mime = item.mimeType ?? "";
  const supported = mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/") || mime === "application/pdf";
  const preview = useQuery({
    queryKey: ["drive-preview", item.id],
    queryFn: async () => {
      const result = await getPreviewUrl(item.id);
      if (!result.success) throw new Error(result.error);
      return result.data.url;
    },
    enabled: supported,
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
        <DialogTitle className="truncate" title={item.name}>{item.name}</DialogTitle>
        <DialogDescription>{fileType(item)} · {formatBytes(item.size)}</DialogDescription>
      </DialogHeader>
      <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-xl bg-muted/50">
        {supported && preview.isPending ? <div className="flex items-center gap-2 py-24 text-sm text-muted-foreground"><Spinner />Loading preview…</div>
          : preview.error ? <Alert variant="destructive" className="m-6"><TriangleAlert /><AlertTitle>Preview could not load</AlertTitle><AlertDescription>{preview.error.message}<Button variant="outline" size="sm" onClick={() => void preview.refetch()}>Try again</Button></AlertDescription></Alert>
          : !url || !supported || mediaError ? <div className="flex flex-col items-center gap-2 px-6 py-12 text-center"><DriveFileIcon item={item} large /><p className="mt-3 text-sm font-medium">{mediaError ? "This preview could not be displayed" : "No preview for this file type"}</p><p className="text-sm text-muted-foreground">Download the file to open it on your device.</p>{mediaError && <Button variant="outline" size="sm" disabled={preview.isFetching} onClick={async () => { const refreshed = await preview.refetch(); if (refreshed.isSuccess) setMediaError(false); }}>{preview.isFetching && <Spinner />}Reload preview</Button>}</div>
          : mime.startsWith("image/") ? <Image src={url} alt={item.name} width={1200} height={800} unoptimized className="max-h-[60dvh] w-auto max-w-full object-contain" onError={() => setMediaError(true)} />
          : mime.startsWith("video/") ? <video src={url} controls playsInline preload="metadata" className="max-h-[60dvh] w-full" aria-label={item.name} onError={rememberPlayback} onLoadedMetadata={restorePlayback} onPlay={() => { playback.current.paused = false; }} onPause={(event) => { if (!event.currentTarget.error) playback.current.paused = true; }} />
          : mime.startsWith("audio/") ? <div className="flex w-full flex-col items-center gap-8 p-8"><DriveFileIcon item={item} large /><audio src={url} controls preload="metadata" className="w-full" aria-label={item.name} onError={rememberPlayback} onLoadedMetadata={restorePlayback} onPlay={() => { playback.current.paused = false; }} onPause={(event) => { if (!event.currentTarget.error) playback.current.paused = true; }} /></div>
          : <PdfPreview url={url} name={item.name} onError={() => setMediaError(true)} />}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Close</Button>
        <Button onClick={() => download.mutate(item.id)} disabled={download.isPending}>{download.isPending ? <Spinner /> : <Download data-icon="inline-start" />}Download</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
