"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Folder, LockKeyhole } from "lucide-react";
import { toast } from "sonner";
import { listDrive, moveItems, permanentlyDeleteItems, trashItems } from "@/app/actions/drive";
import { setFolderPassword } from "@/app/actions/folder-security";
import type { DriveItem } from "@/lib/drive-types";
import { optimisticDriveChange } from "@/lib/drive-cache";
import { DriveAccessError, useFolderAccess } from "@/components/folder-access";
import { useConflictRun, useDriveUndo } from "@/components/drive-undo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/spinner";

export function DriveMoveDialog({ items, onClose, onComplete }: { items: DriveItem[]; onClose: () => void; onComplete: () => void }) {
  const { run } = useFolderAccess();
  const client = useQueryClient();
  const [folderId, setFolderId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const key = ["drive-move-folders", folderId];
  const listing = useQuery({
    queryKey: key,
    queryFn: async () => {
      const result = await listDrive({ folderId, foldersOnly: true });
      if (!result.success) throw new DriveAccessError(result.error, result.lockedFolder);
      return result.data;
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const blocked = new Set(items.filter((item) => item.kind === "folder").map((item) => item.id));
  const sameParent = items.every((item) => item.parentId === folderId);
  const invalidDestination = Boolean(folderId && blocked.has(folderId)) || Boolean(listing.data?.breadcrumbs.some((crumb) => blocked.has(crumb.id)));
  async function openFolder(id: string | null) {
    if (opening) return;
    setOpening(true);
    setOpenError("");
    try {
      const result = await run(() => listDrive({ folderId: id, foldersOnly: true }));
      client.setQueryData(["drive-move-folders", id], result);
      setFolderId(id);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Could not open folder.");
    } finally { setOpening(false); }
  }
  const conflictRun = useConflictRun();
  const { offerUndo } = useDriveUndo();
  const destinationName = listing.data?.currentFolder?.name ?? "All files";
  const mutation = useMutation({
    mutationFn: () => conflictRun((resolutions) => moveItems({ ids: items.map((item) => item.id), parentId: folderId, resolutions }), {
      operation: "move", destinationName,
      optimistic: () => optimisticDriveChange(client, { kind: "move", ids: items.map((item) => item.id), parentId: folderId }),
    }),
    onSuccess: (result) => {
      // Cancelled at the name conflict prompt: stay open so another folder can be picked.
      if (result?.moved.length) offerUndo(`${result.moved.length === 1 ? "Item" : `${result.moved.length} items`} moved to ${destinationName}`, { kind: "move", result });
      else toast("Nothing was moved");
      if (result) onComplete();
    },
    onSettled: () => { void client.invalidateQueries({ queryKey: ["drive"] }); },
  });
  const busy = opening || mutation.isPending;
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>Move {items.length === 1 ? "item" : `${items.length} items`}</DialogTitle><DialogDescription>Choose a destination. Folders move with everything inside them.</DialogDescription></DialogHeader>
      <nav aria-label="Move destination" className="overflow-x-auto">
        <ol className="flex items-center gap-1 whitespace-nowrap text-xs">
          <li><Button variant="ghost" size="sm" disabled={busy} onClick={() => void openFolder(null)}>All files</Button></li>
          {listing.data?.breadcrumbs.map((crumb) => <li key={crumb.id} className="flex items-center gap-1"><ChevronRight className="size-3 shrink-0" /><Button variant="ghost" size="sm" className="max-w-36" disabled={busy} onClick={() => void openFolder(crumb.id)}><span className="truncate">{crumb.name}</span></Button></li>)}
        </ol>
      </nav>
      <div className="min-h-36 max-h-[40dvh] overflow-y-auto rounded-lg border" aria-busy={listing.isFetching || opening}>
        {listing.isPending ? <div className="flex justify-center p-10"><Spinner label="Loading folders" /></div>
          : listing.error ? <div className="flex flex-col gap-3 p-4"><p role="alert" className="text-sm text-muted-foreground">{listing.error.message}</p><Button variant="outline" onClick={() => void openFolder(folderId)} disabled={busy}>{listing.error instanceof DriveAccessError && listing.error.lockedFolder ? "Unlock folder" : "Try again"}</Button></div>
          : listing.data?.items.length ? <ul aria-label="Destination folders">{listing.data.items.map((folder) => <li key={folder.id}><button disabled={busy || blocked.has(folder.id)} onClick={() => void openFolder(folder.id)} className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-45"><Folder className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{folder.name}</span>{folder.isLocked && <LockKeyhole className="size-3.5 shrink-0" />}<ChevronRight className="size-4 shrink-0" /></button></li>)}</ul>
          : <p className="p-5 text-center text-sm text-muted-foreground">No folders here. You can move your selection to this location.</p>}
      </div>
      {(openError || mutation.error) && <p role="alert" className="text-sm text-destructive">{openError || mutation.error?.message}</p>}
      {sameParent && <p className="text-xs text-muted-foreground">Your selection is already in this folder.</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || listing.isPending || Boolean(listing.error) || sameParent || invalidDestination} onClick={() => mutation.mutate()}>{busy && <Spinner />}Move here</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function DriveTrashDialog({ items, permanent = false, onClose, onComplete }: { items: DriveItem[]; permanent?: boolean; onClose: () => void; onComplete: () => void }) {
  const { run } = useFolderAccess();
  const client = useQueryClient();
  const [confirmation, setConfirmation] = useState("");
  const subject = items.length === 1 ? `“${items[0].name}”` : `${items.length} items`;
  const { offerUndo } = useDriveUndo();
  const ids = items.map((item) => item.id);
  const mutation = useMutation({
    mutationFn: () => run(() => permanent ? permanentlyDeleteItems(ids) : trashItems(ids)),
    onMutate: async () => permanent ? undefined : { rollback: await optimisticDriveChange(client, { kind: "trash", ids }) },
    onError: (_error, _variables, context) => context?.rollback(),
    onSuccess: () => {
      if (permanent) toast.success("Permanently deleted");
      else offerUndo(`${subject} moved to Trash`, { kind: "trash", ids });
      onComplete();
    },
    onSettled: () => { void client.invalidateQueries({ queryKey: ["drive"] }); },
  });
  return <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent showCloseButton={!mutation.isPending}>
      <form className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (!mutation.isPending && (!permanent || confirmation === "DELETE")) mutation.mutate(); }}>
        <DialogHeader><DialogTitle className="break-words">{permanent ? "Permanently delete" : "Move to Trash"} {subject}?</DialogTitle><DialogDescription>{permanent ? "All files inside selected folders will also be permanently deleted for the whole family. This cannot be undone." : "Folders move with their contents. You can restore them for 30 days before automatic deletion. Public links will stop working; unfinished uploads inside these folders will be cancelled."}</DialogDescription></DialogHeader>
        {permanent && <FieldGroup><Field><FieldLabel htmlFor="drive-delete-confirmation">Type DELETE to confirm</FieldLabel><Input id="drive-delete-confirmation" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={mutation.isPending} required /></Field></FieldGroup>}
        {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>Cancel</Button><Button type="submit" variant={permanent ? "destructive" : "default"} disabled={mutation.isPending || (permanent && confirmation !== "DELETE")}>{mutation.isPending && <Spinner />}{permanent ? "Delete permanently" : "Move to Trash"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function DrivePasswordDialog({ item, onClose, onComplete }: { item: DriveItem; onClose: () => void; onComplete: () => void }) {
  const { run } = useFolderAccess();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const mutation = useMutation({
    mutationFn: (remove: boolean) => run(() => setFolderPassword({ id: item.id, password: remove ? null : password })),
    onSuccess: (_data, remove) => { toast.success(remove ? "Folder password removed" : "Folder password saved"); window.dispatchEvent(new Event("drive-access-changed")); onComplete(); },
  });
  return <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent showCloseButton={!mutation.isPending}>
      <form className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (password !== confirmation) { setMismatch(true); return; } if (!mutation.isPending) mutation.mutate(false); }}>
        <DialogHeader><DialogTitle>{item.hasPassword ? "Manage folder password" : "Protect folder"}</DialogTitle><DialogDescription className="break-words">Protect “{item.name}” and everything inside it.</DialogDescription></DialogHeader>
        <FieldGroup>
          <Field><FieldLabel htmlFor="folder-new-password">{item.hasPassword ? "New password" : "Password"}</FieldLabel><Input id="folder-new-password" type="password" autoComplete="new-password" required minLength={8} maxLength={256} value={password} onChange={(event) => { setPassword(event.target.value); mutation.reset(); }} disabled={mutation.isPending} /><FieldDescription>At least 8 characters. Keep a safe copy: a forgotten password cannot be recovered here.</FieldDescription></Field>
          <Field data-invalid={mismatch}><FieldLabel htmlFor="folder-confirm-password">Confirm password</FieldLabel><Input id="folder-confirm-password" type="password" autoComplete="new-password" required value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setMismatch(false); }} disabled={mutation.isPending} aria-invalid={mismatch} aria-describedby={mismatch ? "folder-password-error" : undefined} />{mismatch && <FieldError id="folder-password-error" role="alert">Passwords do not match.</FieldError>}</Field>
        </FieldGroup>
        <p className="text-xs leading-relaxed text-muted-foreground">This is an access lock, not end-to-end encryption. Setting a password revokes all public links inside the folder, including subfolders. Removing it does not restore those links.</p>
        {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
        <DialogFooter className="flex-wrap">
          <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          {item.hasPassword && <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>Remove password</Button>}
          <Button type="submit" disabled={mutation.isPending || password.length < 8}>{mutation.isPending && <Spinner />}Save password</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
