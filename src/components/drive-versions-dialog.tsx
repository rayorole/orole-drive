"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Download, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { getDownloadUrl } from "@/app/actions/drive";
import { deleteVersion, getVersionDownloadUrl, listVersions, restoreVersion } from "@/app/actions/versions";
import type { DriveFileVersion, DriveItem } from "@/lib/drive-types";
import { formatBytes } from "@/lib/format-bytes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/spinner";
import { Hint } from "@/components/hint";
import { DriveFileIcon } from "@/components/drive-item";
import { useFolderAccess } from "@/components/folder-access";

/** Everything cached about a file's content after it changes: listings, thumbnail, versions and scan state. */
export function refreshFileContent(client: QueryClient, id: string) {
  void client.invalidateQueries({ queryKey: ["drive"] });
  for (const key of ["drive-thumbnail", "drive-versions", "private-file-scan"]) void client.invalidateQueries({ queryKey: [key, id] });
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function DriveVersionsDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const client = useQueryClient();
  const { run } = useFolderAccess();
  const [deleting, setDeleting] = useState<DriveFileVersion | null>(null);
  const versions = useQuery({
    queryKey: ["drive-versions", item.id],
    queryFn: () => run(() => listVersions(item.id)),
  });
  const download = useMutation({
    mutationFn: (version: DriveFileVersion) => run(() => version.current ? getDownloadUrl(item.id) : getVersionDownloadUrl(version.id)),
    onSuccess: ({ url }) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "";
      anchor.rel = "noopener";
      anchor.click();
    },
    onError: (error) => toast.error(error.message),
  });
  const restore = useMutation({
    mutationFn: (version: DriveFileVersion) => run(() => restoreVersion(version.id)),
    onSuccess: (_item, version) => toast.success(`Restored the version from ${dateFormat.format(new Date(version.createdAt))}`),
    onError: (error) => toast.error(error.message),
    onSettled: () => refreshFileContent(client, item.id),
  });
  const remove = useMutation({
    mutationFn: (version: DriveFileVersion) => run(() => deleteVersion(version.id)),
    onSuccess: () => { toast.success("Version deleted"); setDeleting(null); },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["drive-versions", item.id] });
      // Storage usage counts kept versions.
      void client.invalidateQueries({ queryKey: ["drive"] });
    },
  });
  const busy = restore.isPending || remove.isPending;
  const earlier = versions.data?.filter((version) => !version.current).length ?? 0;

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy} className="sm:max-w-lg">
      <DialogHeader>
        <div className="flex items-center gap-3">
          <DriveFileIcon item={item} />
          <div className="min-w-0"><DialogTitle className="truncate">{item.name}</DialogTitle><DialogDescription>Version history. Uploading a same-named file with Replace keeps the previous contents here, up to 20 versions.</DialogDescription></div>
        </div>
      </DialogHeader>
      {versions.isPending ? <div className="flex justify-center py-8"><Spinner label="Loading versions" /></div>
        : versions.isError ? <p role="alert" className="text-sm text-destructive">{versions.error.message}</p>
        : <ul aria-label="Versions" className="-mx-1 max-h-80 divide-y overflow-y-auto px-1">
          {versions.data.map((version) => {
            const date = dateFormat.format(new Date(version.createdAt));
            return <li key={version.id} className="flex items-center gap-2 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="flex items-center gap-2 text-sm font-medium tabular-nums">{date}{version.current && <Badge variant="secondary">Current</Badge>}</p>
                <p className="truncate text-xs text-muted-foreground">{formatBytes(version.size)} · {version.createdByEmail ?? "Unknown member"}</p>
              </div>
              <Hint label="Download"><Button variant="ghost" size="icon-sm" aria-label={`Download the ${version.current ? "current version" : `version from ${date}`}`} disabled={download.isPending} onClick={() => download.mutate(version)}><Download /></Button></Hint>
              {!version.current && <>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => restore.mutate(version)}>
                  {restore.isPending && restore.variables?.id === version.id ? <Spinner size={14} label="Restoring" /> : <RotateCcw data-icon="inline-start" />}Restore
                </Button>
                <Hint label="Delete version"><Button variant="ghost" size="icon-sm" aria-label={`Delete the version from ${date}`} disabled={busy} onClick={() => setDeleting(version)}><Trash2 /></Button></Hint>
              </>}
            </li>;
          })}
        </ul>}
      {versions.isSuccess && !earlier && <p className="text-sm text-muted-foreground">No earlier versions yet.</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Close</Button></DialogFooter>
    </DialogContent>
    <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open && !remove.isPending) { setDeleting(null); remove.reset(); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this version?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleting && `The version from ${dateFormat.format(new Date(deleting.createdAt))} (${formatBytes(deleting.size)}) is deleted for the whole family. This can’t be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.isError && <p role="alert" className="text-sm text-destructive">{remove.error.message}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={(event) => { event.preventDefault(); if (deleting) remove.mutate(deleting); }}>
            {remove.isPending ? <Spinner size={14} label="Deleting" /> : <Trash2 data-icon="inline-start" />}Delete version
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Dialog>;
}
