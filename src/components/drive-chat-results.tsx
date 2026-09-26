"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ImageOff, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { DriveChatApproval, DriveChatAsset, DriveChatTable, DriveChatTree, DriveItem } from "@/lib/drive-types";
import { formatBytes } from "@/lib/format-bytes";
import { FileTree, type FileTreeNode } from "@/components/assistant-ui/elements/file-tree";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { paper } from "@/components/assistant-ui/elements/surfaces";
import { ChatAttachmentPreview } from "@/components/drive-chat-attachment";
import type { OutgoingAttachment } from "@/components/drive-chat-composer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ChatDriveTree({ tree, onOpen }: { tree: DriveChatTree; onOpen: (item: DriveItem) => void }) {
  const { nodes, items } = useMemo(() => {
    const items = new Map(tree.nodes.filter((node) => node.item).map((node) => [node.id, node.item!]));
    const known = new Set(tree.nodes.map((node) => node.id));
    const children = new Map<string | null, typeof tree.nodes>();
    for (const node of tree.nodes) {
      const parent = node.parentId && known.has(node.parentId) ? node.parentId : null;
      const siblings = children.get(parent);
      if (siblings) siblings.push(node); else children.set(parent, [node]);
    }
    const nodes: FileTreeNode[] = [];
    const visited = new Set<string>();
    const append = (parent: string | null, depth: number) => {
      for (const node of children.get(parent) ?? []) {
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        nodes.push({ path: node.id, name: node.name, kind: node.kind, depth, disabled: !node.item, meta: node.kind === "file" ? formatBytes(node.size) : undefined });
        append(node.id, depth + 1);
      }
    };
    append(null, 0);
    return { nodes, items };
  }, [tree]);
  return <FileTree title={tree.title} nodes={nodes} hasMore={tree.hasMore} onOpen={(node) => { const item = items.get(node.path); if (item) onOpen(item); }} className="max-w-none" />;
}

export function ChatDataTable({ table }: { table: DriveChatTable }) {
  return <div className={cn(paper, "w-full min-w-0 overflow-hidden rounded-2xl")}>
    <div role="region" aria-label={table.title} tabIndex={0} className="max-h-80 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      <table className="w-full border-collapse text-left text-xs">
        <caption className="caption-top px-3 py-2.5 text-left text-[13px] font-medium">{table.title}</caption>
        <thead className="sticky top-0 bg-muted"><tr>{table.columns.map((column, index) => <th key={index} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{column}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, index) => <tr key={index} className="border-t border-border/50">{table.columns.map((_, column) => <td key={column} className={cn("max-w-80 whitespace-pre-wrap break-words px-3 py-2 align-top", typeof row[column] === "number" && "text-right tabular-nums")}>{row[column] ?? "—"}</td>)}</tr>)}</tbody>
      </table>
      {!table.rows.length && <p className="px-3 pb-3 text-xs text-muted-foreground">No rows in this range.</p>}
    </div>
    {table.truncated && <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">Partial results. Ask for another sheet or a narrower range to see more.</p>}
  </div>;
}

/** No signed or data URLs are persisted. Each load/open checks current AI eligibility again. */
export function ChatImageCard({ asset, onOpen }: { asset: DriveChatAsset; onOpen: (item: DriveItem) => void }) {
  const [preview, setPreview] = useState<{ url: string; itemId: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const loadPreview = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    return fetch(`/api/drive/chat/image/${encodeURIComponent(asset.itemId)}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal }).then(async (response) => {
      if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim() !== "image/jpeg") throw new Error("Image unavailable. Access may have changed or this format cannot be previewed.");
      const blob = await response.blob();
      if (controller.signal.aborted) return false;
      const url = URL.createObjectURL(blob);
      objectUrl.current = url;
      setPreview({ url, itemId: asset.itemId });
      setError(null);
      return true;
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Image unavailable. Try refreshing the preview.");
      return false;
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
  }, [asset.itemId]);
  const refresh = useCallback(() => {
    setPreview(null);
    setError(null);
    setLoading(true);
    return loadPreview();
  }, [loadPreview]);
  useEffect(() => {
    void loadPreview();
    const focus = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      request.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [loadPreview, refresh]);
  const visible = preview?.itemId === asset.itemId && !error;
  return <figure className={cn(paper, "flex w-full min-w-0 flex-col overflow-hidden rounded-2xl")}>
    <button type="button" aria-label={`Open ${asset.item?.name ?? "image"}`} disabled={!visible || !asset.item || loading}
      onClick={async () => { if (asset.item && await refresh()) onOpen(asset.item); }} className="flex min-h-32 items-center justify-center bg-muted/30 p-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default">
      {preview && visible ? /* eslint-disable-next-line @next/next/no-img-element -- Authorized, short-lived browser object URL. */
        <img src={preview.url} alt={asset.alt || asset.item?.name || "Drive image"} className="max-h-72 max-w-full rounded-lg object-contain" onError={() => { setError("The image could not be displayed. Refresh to try again."); setPreview(null); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; }} />
        : loading ? <GenerationLoader label="Loading image" /> : <ImageOff aria-hidden="true" className="size-6 text-muted-foreground" />}
    </button>
    <figcaption className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[13px] font-medium">{asset.item?.name ?? "Drive image"}</span><Button variant="ghost" size="icon-xs" aria-label="Refresh image permission and preview" disabled={loading} onClick={() => void refresh()}><RefreshCw /></Button></div>
      {error && <p role="alert" className="text-xs text-muted-foreground">{error}</p>}
      {visible && asset.description && <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{asset.description}</p>}
      {visible && asset.ocr && <details className="text-xs"><summary className="cursor-pointer py-1 text-muted-foreground">Text in this image</summary><p className="max-h-48 overflow-auto whitespace-pre-wrap break-words pt-2">{asset.ocr}</p></details>}
    </figcaption>
  </figure>;
}

const ACTION_LABELS: Record<DriveChatApproval["request"]["operation"], string> = { create_file: "Create file", create_folder: "Create folder", rename_item: "Rename item", move_items: "Move items", save_attachment: "Save to Drive" };

export function ChatApprovalCard({ approval, persisted, running, attachment, onDecide }: { approval: DriveChatApproval; persisted: boolean; running: boolean; attachment?: OutgoingAttachment; onDecide: (decision: "approve" | "cancel") => Promise<void> }) {
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(() => Date.parse(approval.expiresAt) <= Date.now());
  useEffect(() => {
    const remaining = Date.parse(approval.expiresAt) - Date.now();
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [approval.expiresAt]);
  const request = approval.request;
  const pending = approval.status === "pending";
  const missingBytes = request.operation === "save_attachment" && !attachment;
  const blocked = !persisted || running || Boolean(busy);
  async function decide(decision: "approve" | "cancel") {
    if (busy || blocked || !pending) return;
    setBusy(decision);
    setError(null);
    try { await onDecide(decision); } catch (cause) { setError(cause instanceof Error ? cause.message : "The action could not be completed. Refresh this chat before trying again."); } finally { setBusy(null); }
  }
  return <section aria-label={approval.title} className={cn(paper, "flex w-full min-w-0 flex-col gap-3 rounded-2xl p-3.5")}>
    <div className="flex items-center gap-2"><ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><h3 className="min-w-0 text-[13px] font-medium">{approval.title}</h3></div>
    <ul className="flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">{approval.details.map((detail, index) => <li key={index} className="break-words">{detail}</li>)}</ul>
    {"name" in request && <p className="break-all text-xs"><span className="text-muted-foreground">Name: </span>{request.name}</p>}
    {request.operation === "save_attachment" && <p className="text-xs text-muted-foreground">Original file · {formatBytes(request.size)} · {request.mimeType}</p>}
    {request.operation === "save_attachment" && attachment && <ChatAttachmentPreview file={attachment} />}
    {request.operation === "create_file" && <div className="flex min-w-0 flex-col gap-1.5"><p className="text-xs font-medium">File contents <span className="font-normal text-muted-foreground">· {request.mimeType}</span></p><pre tabIndex={0} aria-label="Full proposed file contents" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring">{request.content}</pre></div>}
    {pending && <>
      <p className="text-xs leading-relaxed text-muted-foreground">{!persisted || running ? "You can approve once this answer has finished and is saved." : expired ? "This proposal expired. Ask for a new one before making changes." : missingBytes ? "Original bytes are no longer in this tab. Reattach the file and ask to save it again; chat history keeps metadata only." : "Review the exact destination and contents above. Nothing changes until you approve."}</p>
      <div className="flex flex-wrap items-center gap-2"><Button size="sm" disabled={blocked || expired || missingBytes} onClick={() => void decide("approve")}>{busy === "approve" ? "Applying…" : ACTION_LABELS[request.operation]}</Button><Button variant="outline" size="sm" disabled={blocked} onClick={() => void decide("cancel")}>{busy === "cancel" ? "Cancelling…" : "Cancel"}</Button></div>
    </>}
    {approval.status === "executing" && <GenerationLoader label="Applying approved action" />}
    {approval.status === "completed" && <div role="status" className="flex flex-col gap-1 text-xs"><p className="flex items-center gap-1.5 font-medium"><Check aria-hidden="true" className="size-3.5" />Completed</p>{approval.result?.names.map((name, index) => <p key={approval.result?.itemIds[index] ?? index} className="break-words">{name}</p>)}</div>}
    {approval.status === "cancelled" && <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><X aria-hidden="true" className="size-3.5" />Cancelled. No changes were made.</p>}
    {(error || approval.status === "failed") && <p role="alert" className="text-xs leading-relaxed text-destructive">{error ?? approval.error ?? "The action failed. Ask for a new proposal."}</p>}
  </section>;
}
