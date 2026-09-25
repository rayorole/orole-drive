"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import { getFileScanStatus, getPublicFileScanStatus, submitFileScan } from "@/app/actions/virustotal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/spinner";

const STATUS_META = {
  unknown: { label: "No scan result", icon: ShieldQuestion, variant: "secondary" as const },
  pending: { label: "Scanning…", icon: ShieldQuestion, variant: "secondary" as const },
  clean: { label: "No detections", icon: ShieldCheck, variant: "default" as const },
  suspicious: { label: "Suspicious", icon: ShieldAlert, variant: "destructive" as const },
  malicious: { label: "Malicious", icon: ShieldX, variant: "destructive" as const },
};

type FileScanBadgeProps = { token: string; itemId?: never; size?: never } | { token?: never; itemId: string; size: number };

export function FileScanBadge({ token, itemId, size }: FileScanBadgeProps) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isPrivate = itemId !== undefined;
  const queryKey = isPrivate ? ["private-file-scan", itemId] : ["public-file-scan", token];
  const status = useQuery({
    queryKey,
    queryFn: async () => {
      const result = itemId !== undefined ? await getFileScanStatus(itemId) : await getPublicFileScanStatus(token!);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    staleTime: 30_000,
    retry: false,
    refetchInterval: (query) => query.state.data?.status === "pending" ? 30_000 : false,
  });
  const submit = useMutation({
    mutationFn: async () => {
      if (itemId === undefined) throw new Error("Only a signed-in writer can submit files.");
      const result = await submitFileScan(itemId, true);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      setConfirmOpen(false);
    },
  });

  if (status.isPending) return <Badge variant="secondary"><Spinner size={12} label="Checking scan status" /></Badge>;
  if (status.isError || !status.data) return <div className="flex flex-wrap items-center gap-2">
    <Badge variant="outline"><ShieldQuestion data-icon="inline-start" />Scan status unavailable</Badge>
    <Button type="button" variant="ghost" size="sm" onClick={() => void status.refetch()} disabled={status.isFetching}>Retry</Button>
  </div>;
  if (!status.data.configured && status.data.status === "unknown") return <Badge variant="outline"><ShieldQuestion data-icon="inline-start" />Scanning not configured</Badge>;

  const meta = STATUS_META[status.data.status];
  const Icon = meta.icon;
  const canSubmit = isPrivate && status.data.eligibleForSubmission;

  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2" aria-live="polite">
    <Badge variant={meta.variant}><Icon data-icon="inline-start" />{meta.label}</Badge>
    {status.data.permalink && status.data.status !== "unknown" &&
      <a href={status.data.permalink} target="_blank" rel="noreferrer noopener" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
        View on VirusTotal
      </a>}
    <Button type="button" variant="ghost" size="sm" onClick={() => void status.refetch()} disabled={status.isFetching || submit.isPending}>
      {status.isFetching ? <Spinner label="Refreshing scan status" /> : "Refresh"}
    </Button>
    {canSubmit && <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!submit.isPending) setConfirmOpen(open); }}>
      <AlertDialogTrigger render={<Button type="button" variant="outline" size="sm" />}>Scan this file</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Send this file to VirusTotal?</AlertDialogTitle>
          <AlertDialogDescription>
            This sends the entire file to VirusTotal, not just its hash. VirusTotal may retain the file and distribute
            it and its contents to security partners and customers. Do not submit private, confidential, or personal
            information. Continue only if you have permission to share this file outside Orole Drive.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {submit.isError && <p role="alert" className="text-sm text-destructive">{submit.error.message}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submit.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={submit.isPending} onClick={(event) => { event.preventDefault(); submit.mutate(); }}>
            {submit.isPending ? <Spinner /> : "Send and scan"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>}
    </div>
    {status.data.status === "clean" && <p className="text-xs text-muted-foreground">No detections in the available report. This does not guarantee the file is safe.</p>}
    {status.data.scannedAt && <p className="text-xs text-muted-foreground">Last checked {new Date(status.data.scannedAt).toLocaleString()}</p>}
    {isPrivate && status.data.status === "unknown" && <p className="text-xs text-muted-foreground">
      {size! > status.data.submissionSizeLimit
        ? "This file exceeds VirusTotal’s 650 MB submission limit. It has not been sent."
        : "Opening Details only looks up a file hash for files up to 100 MiB. File contents are never submitted automatically."}
    </p>}
    {!isPrivate && status.data.status === "unknown" && <p className="text-xs text-muted-foreground">No report has been saved by the owner. Public visitors cannot submit this file.</p>}
    {!isPrivate && status.data.status === "pending" && <p className="text-xs text-muted-foreground">Waiting for the owner to refresh the VirusTotal analysis.</p>}
  </div>;
}
