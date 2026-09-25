"use client";

import { useRef, useState, type SyntheticEvent } from "react";
import Image from "next/image";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, Link2, Link2Off, QrCode, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { createFolder, renameItem, setPublic } from "@/app/actions/drive";
import { setItemSharing } from "@/app/actions/item-access";
import { getDownloadUrl, getPreviewUrl, getItemSharing, listShareMembers } from "@/lib/drive-read-client";
import type { DriveAccessMode, DriveItem, ItemSharing } from "@/lib/drive-types";
import { canManageItem, permissionLabel } from "@/lib/drive-permissions";
import { getPreviewKind, isOfficeKind } from "@/lib/file-preview";
import { invalidateDriveMetadata, optimisticDriveChange } from "@/lib/drive-cache";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/spinner";
import { DriveFileIcon, fileType } from "@/components/drive-item";
import { formatBytes } from "@/lib/format-bytes";
import { PdfPreview } from "@/components/pdf-preview";
import { TextPreview } from "@/components/text-preview";
import { OfficePreview } from "@/components/office-preview";
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
    onSettled: () => {
      if (item) {
        invalidateDriveMetadata(queryClient, [item.id]);
        void queryClient.invalidateQueries({ queryKey: ["storage-usage"] });
      } else void queryClient.invalidateQueries({ queryKey: ["drive"] });
    },
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
          <DialogDescription>{item ? "Choose a name that is easy to find." : parentId ? "New folders inherit this parent’s access, including public folder links. You can choose Only me afterward in Manage access." : "New folders in All files are private. Only you can access them until you share."}</DialogDescription>
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
  const { run } = useFolderAccess();
  const owner = canManageItem(item);
  const sharing = useQuery({
    queryKey: ["drive-sharing", item.id],
    queryFn: ({ signal }) => run(() => getItemSharing(item.id, signal)),
    enabled: owner,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  if (owner && sharing.data) return <OwnerShareDialog item={item} initial={sharing.data} onClose={onClose} />;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>Access settings</DialogTitle><DialogDescription><TruncatedText as="span" className="block">{item.name}</TruncatedText></DialogDescription></DialogHeader>
      {owner ? sharing.isError
        ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>Could not load access</AlertTitle><AlertDescription>{sharing.error.message}<Button variant="outline" onClick={() => void sharing.refetch()}>Try again</Button></AlertDescription></Alert>
        : <div role="status" className="flex items-center gap-2 text-sm"><Spinner />Loading access…</div>
        : <div className="flex flex-col gap-3">
          <p className="text-sm">Your access: <strong>{permissionLabel[item.permission]}</strong></p>
          <p className="text-sm text-muted-foreground">{item.permission === "editor" ? "You can edit and organize this item. Only the owner can change sharing or passwords." : "You can view, download, favorite and copy this item into a writable location. Only the owner can change sharing."}</p>
          {item.owner && <p className="break-words text-xs text-muted-foreground">Owner: {item.owner.name || item.owner.email}{item.owner.name && ` · ${item.owner.email}`}</p>}
          {item.accessMode === "inherit" && <p className="text-xs text-muted-foreground">Member access is inherited from the parent folder.</p>}
        </div>}
      <DialogFooter><Button variant="outline" onClick={onClose}>Done</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

const ROLE_OPTIONS = [{ value: "viewer" as const, label: "Viewer" }, { value: "editor" as const, label: "Editor" }];
const ACCESS_LABELS = { private: "Only me", inherit: "Inherit from parent", members: "All drive members", selected: "Selected members", public: "Public link" };

function SharingRole({ value, onChange, label, disabled }: { value: "viewer" | "editor"; onChange: (role: "viewer" | "editor") => void; label: string; disabled: boolean }) {
  return <Select value={value} items={ROLE_OPTIONS} disabled={disabled} onValueChange={(role) => { if (role) onChange(role); }}>
    <SelectTrigger size="sm" aria-label={label} className="w-24 shrink-0"><SelectValue /></SelectTrigger>
    <SelectContent><SelectGroup>{ROLE_OPTIONS.map((role) => <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>;
}

function OwnerShareDialog({ item, initial, onClose }: { item: DriveItem; initial: ItemSharing; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { run } = useFolderAccess();
  const folder = item.kind === "folder";
  const [saved, setSaved] = useState(initial);
  const [mode, setMode] = useState<DriveAccessMode | "public">(item.publicToken ? "public" : initial.accessMode);
  const [memberRole, setMemberRole] = useState(initial.memberRole);
  const [members, setMembers] = useState(initial.members);
  const [search, setSearch] = useState("");
  const [url, setUrl] = useState<string | null>(item.publicToken ? `${window.location.origin}/s/${item.publicToken}` : null);
  const [expiresAt, setExpiresAt] = useState(item.publicExpiresAt);
  const [expiry, setExpiry] = useState(item.publicExpiresAt ? "current" : "never");
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const accounts = useQuery({
    queryKey: ["drive-share-members"],
    queryFn: ({ signal }) => run(() => listShareMembers(signal)),
    enabled: mode === "selected",
    retry: false,
    staleTime: 60_000,
  });
  const results = accounts.data?.filter((account) => account.id !== item.owner?.id && !members.some((member) => member.id === account.id) && `${account.name} ${account.email}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  const modes = (["private", ...(initial.hasParent ? ["inherit" as const] : []), "members", "selected", "public"] as const).map((value) => ({ value, label: ACCESS_LABELS[value] }));
  const expiryItems = expiresAt ? [{ value: "current", label: `Until ${new Date(expiresAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}` }, ...EXPIRY_OPTIONS] : EXPIRY_OPTIONS;
  function invalidate(sharing: ItemSharing = saved) {
    // The owner keeps the freshly saved sharing dialog (and its copyable link), never other cached access.
    queryClient.setQueryData(["drive-sharing", item.id], sharing);
    window.dispatchEvent(new CustomEvent("drive-access-changed", { detail: { keepSharingId: item.id } }));
  }
  const access = useMutation({
    mutationFn: () => {
      if (mode === "public") throw new Error("Choose member access before saving.");
      return run(() => setItemSharing({ id: item.id, accessMode: mode, memberRole, members: mode === "selected" ? members.map((member) => ({ userId: member.id, role: member.role })) : [], revokePublic: true }));
    },
    onSuccess: (result) => {
      setSaved(result);
      setMembers(result.members);
      setUrl(null);
      setExpiresAt(null);
      setExpiry("never");
      setShowQr(false);
      toast.success(url ? "Access saved and public link revoked" : "Access saved");
      invalidate(result);
    },
  });
  const link = useMutation({
    mutationFn: ({ enabled, choice }: { enabled: boolean; choice?: string }) =>
      run(() => setPublic({ id: item.id, enabled, expiresIn: choice === undefined || choice === "current" ? undefined : choice === "never" ? null : Number(choice) })),
    onSuccess: (result, { enabled }) => {
      toast.success(!enabled ? "Public link revoked" : url ? "Link expiry updated" : "Public link created");
      setUrl(result.url);
      setExpiresAt(result.expiresAt);
      setExpiry(result.expiresAt ? "current" : "never");
      if (!enabled) { setMode(saved.accessMode); setShowQr(false); }
      invalidate();
      if (!folder) void queryClient.invalidateQueries({ queryKey: ["private-file-scan", item.id] });
    },
  });
  const busy = access.isPending || link.isPending;
  async function copyLink() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { toast.error("Could not copy the link. Select the link and copy it manually."); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" showCloseButton={!busy}>
      <DialogHeader className="pr-7"><DialogTitle>Manage access</DialogTitle><DialogDescription><TruncatedText as="span" className="block">{item.name}</TruncatedText></DialogDescription></DialogHeader>
      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel htmlFor="share-access">Who can access</FieldLabel>
          <Select value={mode} items={modes} disabled={busy} onValueChange={(value) => { if (value) { setMode(value); access.reset(); link.reset(); } }}>
            <SelectTrigger id="share-access" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{modes.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
          <FieldDescription>{mode === "private" ? "Only you can access this item, even when its parent is shared." : mode === "inherit" ? `Uses the parent folder’s member access${saved.inheritedFrom ? ` from “${saved.inheritedFrom.name}”` : ""}. An inherited item can also be reached through a public parent link. Choose Only me to stop inheritance.` : mode === "members" ? "Every registered, verified drive member can access this item, including members added later." : mode === "selected" ? "Only you and the registered members selected below can access this item." : "Anyone with the link can view and download without signing in. They cannot edit."}</FieldDescription>
        </Field>
        {mode === "members" && <Field orientation="horizontal"><FieldLabel className="flex-1">Member role</FieldLabel><SharingRole value={memberRole} onChange={setMemberRole} label="Role for all drive members" disabled={busy} /></Field>}
        {mode === "selected" && <Field>
          <FieldLabel htmlFor="share-member-search">Add members</FieldLabel>
          <Input id="share-member-search" type="search" placeholder="Search registered names or emails…" value={search} disabled={busy} onChange={(event) => setSearch(event.target.value)} />
          {accounts.isPending ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner />Loading members…</p>
            : accounts.isError ? <p role="alert" className="text-sm text-destructive">{accounts.error.message} <Button variant="ghost" size="sm" onClick={() => void accounts.refetch()}>Retry</Button></p>
              : <ul aria-label="Available drive members" className="max-h-40 overflow-y-auto rounded-lg border">
                {results.length ? results.map((account) => <li key={account.id}><button type="button" disabled={busy} onClick={() => { setMembers([...members, { ...account, role: "viewer" }]); setSearch(""); }} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <span className="min-w-0 flex-1"><TruncatedText as="span" className="block text-sm">{account.name || account.email}</TruncatedText><TruncatedText as="span" className="block text-xs text-muted-foreground">{account.email}</TruncatedText></span><span className="text-xs text-muted-foreground">Add</span>
                </button></li>) : <li className="p-3 text-xs text-muted-foreground">{search ? "No matching registered members." : "No more members to add."}</li>}
              </ul>}
          {members.length > 0 && <ul aria-label="Selected members" className="flex flex-col gap-3 pt-2">{members.map((member) => <li key={member.id} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1"><TruncatedText as="span" className="block text-sm">{member.name || member.email}</TruncatedText><TruncatedText as="span" className="block text-xs text-muted-foreground">{member.email}</TruncatedText></span>
            <SharingRole value={member.role} label={`Role for ${member.email}`} disabled={busy} onChange={(role) => setMembers(members.map((entry) => entry.id === member.id ? { ...entry, role } : entry))} />
            <Hint label={`Remove ${member.email}`}><Button variant="ghost" size="icon-sm" aria-label={`Remove ${member.email}`} disabled={busy} onClick={() => setMembers(members.filter((entry) => entry.id !== member.id))}><X /></Button></Hint>
          </li>)}</ul>}
          {!members.length && <FieldDescription>No members selected. Only you will have access.</FieldDescription>}
        </Field>}
        {(mode === "members" || mode === "selected") && <p className="text-xs text-muted-foreground">Viewers can preview, download and copy. Editors can also upload, edit, move and delete. Only you can manage sharing and passwords.</p>}
        {folder && mode !== "public" && <p className="text-xs text-muted-foreground">Contents inherit folder access, including future uploads. Items with their own access setting keep that setting; Only me items stay private.</p>}
        {mode !== "public" && url && <Alert><Link2Off /><AlertTitle>Saving will revoke the public link</AlertTitle><AlertDescription>Member access and link revocation are saved together. Copies already downloaded cannot be recalled.</AlertDescription></Alert>}
        {mode === "public" && <>
          <p className="text-xs text-muted-foreground">Signed-in member access stays set to <strong>{ACCESS_LABELS[saved.accessMode]}</strong>. Revoking this link does not remove that access.</p>
          {item.isProtected ? <Alert><TriangleAlert /><AlertTitle>Public links unavailable</AlertTitle><AlertDescription>Password-protected items and items inside protected folders cannot have public links.</AlertDescription></Alert> : <>
            {folder && <p className="text-xs text-muted-foreground">The link includes contents that inherit this folder’s access, including future uploads. Password-protected items and items with their own access setting stay hidden.</p>}
            <Field orientation="horizontal"><FieldLabel id="share-expiry-label" className="flex-1">Link expires</FieldLabel>
              <Select value={expiry} items={expiryItems} disabled={busy} onValueChange={(value) => { if (value) { if (url) link.mutate({ enabled: true, choice: value }); else setExpiry(value); } }}>
                <SelectTrigger size="sm" aria-labelledby="share-expiry-label" className="w-auto max-w-64"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{expiryItems.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
          </>}
          {url && <Field>
            <FieldLabel htmlFor="public-link">Public link</FieldLabel>
            <div className="flex gap-2"><Input id="public-link" value={url} readOnly onFocus={(event) => event.target.select()} /><Button onClick={copyLink}>{copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}{copied ? "Copied" : "Copy"}</Button></div>
            <Button variant="ghost" size="sm" className="self-start" aria-expanded={showQr} onClick={() => setShowQr(!showQr)}><QrCode data-icon="inline-start" />{showQr ? "Hide QR code" : "Show QR code"}</Button>
            {showQr && <ShareQr url={url} />}
            {!folder && <ScanStatusLine itemId={item.id} />}
          </Field>}
          {!url && !item.isProtected && <p className="text-xs text-muted-foreground">{!folder && "Creating a link sends the entire file to VirusTotal, which may retain and distribute its contents. Do not share confidential or personal information. "}Your verified email appears on the public page. You can revoke the link at any time.</p>}
        </>}
      </FieldGroup>
      {(access.error || link.error) && <p role="alert" className="text-sm text-destructive">{access.error?.message || link.error?.message}</p>}
      <DialogFooter className="sm:justify-between">
        {mode === "public" ? url
          ? <Hint label="Stops new visits immediately. Copies already downloaded cannot be recalled."><Button variant="destructive" disabled={busy} onClick={() => link.mutate({ enabled: false })}>{busy ? <Spinner /> : <Link2Off data-icon="inline-start" />}Revoke link</Button></Hint>
          : <Button disabled={busy || item.isProtected} onClick={() => link.mutate({ enabled: true, choice: expiry })}>{busy ? <Spinner /> : <Link2 data-icon="inline-start" />}Create public link</Button>
          : <Button disabled={busy} onClick={() => access.mutate()}>{busy && <Spinner />}Save access</Button>}
        <Button variant="outline" onClick={onClose} disabled={busy}>Done</Button>
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
      const result = await run(() => getPreviewUrl(item.id, signal));
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
          : !url || !kind || mediaError ? <div className="flex flex-col items-center gap-2 px-6 py-12 text-center"><DriveFileIcon item={item} large /><p className="mt-3 text-sm font-medium">{mediaError ? "This preview could not be displayed" : "No preview for this file type"}</p><p className="text-sm text-muted-foreground">{/\.(?:doc|xls|ppt)$/i.test(item.name) ? "Legacy Office files are download-only. Preview supports DOCX, XLSX and PPTX." : "Download the file to open it on your device."}</p>{mediaError && <Button variant="outline" size="sm" disabled={preview.isFetching} onClick={async () => { const refreshed = await preview.refetch(); if (refreshed.isSuccess) setMediaError(false); }}>{preview.isFetching && <Spinner />}Reload preview</Button>}</div>
          : kind === "text" ? <TextPreview key={preview.dataUpdatedAt} url={url} name={item.name} size={item.size} onReload={() => { void preview.refetch(); }} isReloading={preview.isFetching} />
          : isOfficeKind(kind) ? <OfficePreview key={preview.dataUpdatedAt} url={url} name={item.name} size={item.size} kind={kind} onReload={() => { void preview.refetch(); }} isReloading={preview.isFetching} />
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
