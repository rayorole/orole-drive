"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { emptyTrash, getTrashSummary } from "@/app/actions/drive";
import { formatBytes } from "@/lib/format-bytes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/spinner";
import { useFolderAccess } from "@/components/folder-access";

const plural = (count: number) => `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;

export function EmptyTrashDialog({ onClose }: { onClose: () => void }) {
  const { run } = useFolderAccess();
  const client = useQueryClient();
  const [confirmation, setConfirmation] = useState("");
  const summary = useQuery({ queryKey: ["drive-trash-summary"], queryFn: () => run(() => getTrashSummary()), staleTime: 0, gcTime: 0 });
  const mutation = useMutation({
    mutationFn: () => run(() => emptyTrash()),
    onSuccess: ({ deleted, pending, skippedLocked }) => {
      const kept = skippedLocked ? `${plural(skippedLocked)} inside locked folders ${skippedLocked === 1 ? "was" : "were"} kept. Unlock ${skippedLocked === 1 ? "it" : "them"} to delete.` : undefined;
      if (!deleted && !pending) toast.info("Nothing was deleted", { description: kept });
      else toast.success(pending ? `Trash emptied. ${plural(pending)} ${pending === 1 ? "is" : "are"} still being removed in the background.` : `Trash emptied. ${plural(deleted)} permanently deleted.`, { description: kept });
      onClose();
    },
    // Listings, storage totals and the activity history all change.
    onSettled: () => { void client.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("drive") }); },
  });
  const data = summary.data;
  const ready = Boolean(data?.count) && confirmation === "DELETE" && !mutation.isPending;
  return <Dialog open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent showCloseButton={!mutation.isPending}>
      <form className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (ready) mutation.mutate(); }}>
        <DialogHeader>
          <DialogTitle>Empty Trash?</DialogTitle>
          <DialogDescription>{!data ? "Checking what’s in Trash…" : data.count ? `${plural(data.count)} (${formatBytes(data.bytes)}) will be permanently deleted for the whole family, including everything inside folders. This cannot be undone.` : "There’s nothing in Trash you can delete."}</DialogDescription>
        </DialogHeader>
        {summary.isPending && <Skeleton className="h-3 w-2/5" />}
        {data && data.skippedLocked > 0 && <p className="text-xs leading-relaxed text-muted-foreground">{plural(data.skippedLocked)} inside locked folders will be kept. Unlock those folders first to delete them too.</p>}
        {data && data.count > 0 && <FieldGroup><Field><FieldLabel htmlFor="drive-empty-trash-confirmation">Type DELETE to confirm</FieldLabel><Input id="drive-empty-trash-confirmation" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={mutation.isPending} required /></Field></FieldGroup>}
        {(summary.error ?? mutation.error) && <p role="alert" className="text-sm text-destructive">{(summary.error ?? mutation.error)!.message}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>Cancel</Button><Button type="submit" variant="destructive" disabled={!ready}>{mutation.isPending && <Spinner />}Empty Trash</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
