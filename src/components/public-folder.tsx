"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { Archive, Check, ChevronRight, Download, File, FileImage, FileMusic, FileText, FileVideo, Folder, Link2 } from "lucide-react";
import { toast } from "sonner";
import { getPublicFolderArchive, getPublicFolderFileAccess } from "@/app/actions/public";
import { useArchiveDownloader, type ArchiveSource } from "@/components/drive-archive";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";
import type { ActionResult, PublicFolderView, PublicShareCrumb, PublicShareItem } from "@/lib/drive-types";
import { getPreviewKind } from "@/lib/file-preview";
import { formatBytes } from "@/lib/format-bytes";
import { FolderIcon } from "@/components/folder-icon";

const KIND_ICONS = { image: FileImage, video: FileVideo, audio: FileMusic, pdf: FileText, text: FileText, docx: FileText, xlsx: FileText, pptx: FileText } as const;

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

const folderHref = (token: string, id: string, rootId: string) => id === rootId ? `/s/${token}` : `/s/${token}?folder=${id}`;

/** Trail inside a folder share. It starts at the shared folder; nothing above it is ever known to the page. */
export function PublicShareBreadcrumbs({ token, crumbs, current }: { token: string; crumbs: PublicShareCrumb[]; current?: string }) {
  const trail = current === undefined ? crumbs.slice(0, -1) : crumbs;
  const here = current ?? crumbs[crumbs.length - 1]?.name;
  if (!trail.length) return null;
  return <nav aria-label="Folder path" className="min-w-0">
    <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
      {trail.map((crumb) => <li key={crumb.id} className="flex min-w-0 items-center gap-1">
        <Link href={folderHref(token, crumb.id, crumbs[0].id)} className="max-w-48 truncate rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{crumb.name}</Link>
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
      </li>)}
      <li aria-current="page" className="max-w-64 truncate text-foreground">{here}</li>
    </ol>
  </nav>;
}

function ItemIcon({ item }: { item: PublicShareItem }) {
  if (item.kind === "folder") return <FolderIcon item={item} />;
  const kind = getPreviewKind(item);
  const Icon = kind ? KIND_ICONS[kind] : File;
  return <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/65 text-muted-foreground">
    <Icon className="size-5" strokeWidth={1.6} />
  </span>;
}

export function PublicFolder({ token, view }: { token: string; view: PublicFolderView }) {
  const root = view.breadcrumbs[0];
  const current = view.breadcrumbs[view.breadcrumbs.length - 1];
  const [linkCopied, setLinkCopied] = useState(false);
  const source = useMemo<ArchiveSource>(() => ({
    getManifest: async ([folderId]) => unwrap(await getPublicFolderArchive(token, folderId)),
    getDownloadUrl: async (id) => unwrap(await getPublicFolderFileAccess(token, id)).downloadUrl,
  }), [token]);
  const archive = useArchiveDownloader(source);
  const download = useMutation({
    mutationFn: async (id: string) => unwrap(await getPublicFolderFileAccess(token, id)).downloadUrl,
    onSuccess: (url) => window.location.assign(url),
    onError: (error) => toast.error(error.message),
  });

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("Link copied");
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1600);
    } catch {
      toast.error("Could not copy the link. Copy it from the address bar.");
    }
  }

  return <section aria-labelledby="shared-folder-title" className="flex w-full flex-col gap-6">
    <PublicShareBreadcrumbs token={token} crumbs={view.breadcrumbs} />
    <header className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center"><FolderIcon item={current} /></span>
        <div className="min-w-0">
          <h1 id="shared-folder-title" className="wrap-anywhere text-xl font-semibold tracking-[-0.02em] text-balance sm:text-2xl">{current.name}</h1>
          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <div><dt className="sr-only">Contents</dt><dd className="tabular-nums">{view.truncated ? `${view.items.length.toLocaleString("en")}+ items` : `${view.items.length.toLocaleString("en")} ${view.items.length === 1 ? "item" : "items"}`}</dd></div>
            {view.share.sharedByEmail && <div className="min-w-0"><dt className="inline">Shared by </dt><dd className="inline wrap-anywhere text-foreground">{view.share.sharedByEmail}</dd></div>}
            {view.share.expiresAt && <div><dt className="inline">Link expires </dt><dd className="inline"><time dateTime={view.share.expiresAt} suppressHydrationWarning>{new Date(view.share.expiresAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</time></dd></div>}
          </dl>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="outline" onClick={copyLink}>{linkCopied ? <Check data-icon="inline-start" /> : <Link2 data-icon="inline-start" />}Copy link</Button>
        <Button disabled={archive.isPending || !view.items.length} onClick={() => archive.start([current.id])}>
          {archive.isPending ? <Spinner label="Preparing ZIP" /> : <Archive data-icon="inline-start" />}Download all
        </Button>
      </div>
    </header>

    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[var(--surface-shadow)]">
      {view.items.length ? <ul aria-label={`Contents of ${current.name}`} className="divide-y divide-border/60">
        {view.items.map((item) => <li key={item.id} className="relative flex min-h-14 items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/40 focus-within:bg-muted/40">
          <ItemIcon item={item} />
          <Link
            href={item.kind === "folder" ? folderHref(token, item.id, root.id) : `/s/${token}?file=${item.id}`}
            className="min-w-0 flex-1 truncate text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
          >{item.name}</Link>
          <span className="hidden w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">{item.kind === "file" ? formatBytes(item.size) : "Folder"}</span>
          <time dateTime={item.updatedAt} suppressHydrationWarning className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground md:block">{new Date(item.updatedAt).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}</time>
          {item.kind === "file"
            ? <Button variant="ghost" size="icon" className="relative z-10 shrink-0" aria-label={`Download ${item.name}`} disabled={download.isPending && download.variables === item.id} onClick={() => download.mutate(item.id)}>
              {download.isPending && download.variables === item.id ? <Spinner label={`Preparing ${item.name}`} /> : <Download />}
            </Button>
            : <ChevronRight aria-hidden="true" className="mx-2.5 size-4 shrink-0 text-muted-foreground" />}
        </li>)}
      </ul> : <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-6 py-14 text-center">
        <span aria-hidden="true" className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><Folder className="size-7" strokeWidth={1.4} /></span>
        <p className="font-medium">This folder is empty</p>
      </div>}
    </div>
    {view.truncated && <p className="text-sm text-muted-foreground">Showing the first {view.items.length.toLocaleString("en")} items. Download all to get everything in this folder.</p>}
    {archive.dialog}
  </section>;
}
