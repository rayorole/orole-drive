"use client";

import { useId, useMemo, useState, type ComponentProps } from "react";
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { mono, paper } from "./surfaces";

export interface FileTreeNode {
  path: string;
  name: string;
  depth: number;
  kind: "folder" | "file";
  meta?: string;
  disabled?: boolean;
  additions?: number;
  deletions?: number;
}

type Branch = { node: FileTreeNode; children: Branch[] };

function branches(nodes: readonly FileTreeNode[]) {
  const roots: Branch[] = [];
  const parents: Branch[] = [];
  for (const node of nodes) {
    while (parents.length && parents[parents.length - 1].node.depth >= node.depth) parents.pop();
    const branch: Branch = { node, children: [] };
    (parents.length ? parents[parents.length - 1].children : roots).push(branch);
    if (node.kind === "folder") parents.push(branch);
  }
  return roots;
}

function TreeBranch({ branch, onOpen, defaultExpanded }: { branch: Branch; onOpen?: (node: FileTreeNode) => void; defaultExpanded: boolean }) {
  const { node, children } = branch;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const id = useId();
  const folder = node.kind === "folder";
  const Icon = folder ? expanded && children.length ? FolderOpenIcon : FolderIcon : FileIcon;
  const label = <><Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{node.name}</span>{node.meta && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{node.meta}</span>}{Boolean(node.additions || node.deletions) && <span className={cn(mono, "shrink-0 tabular-nums")}>{node.additions ? `+${node.additions}` : ""} {node.deletions ? `−${node.deletions}` : ""}</span>}</>;
  return <li className="min-w-0">
    <div className="flex min-w-0 items-center gap-0.5 rounded-lg hover:bg-foreground/[0.04]">
      {folder ? <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`} aria-expanded={expanded} aria-controls={id}
        onClick={() => setExpanded((value) => !value)} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setExpanded(event.key === "ArrowRight"); } }}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronRightIcon aria-hidden="true" className={cn("size-3.5", expanded && "rotate-90")} /></button> : <span className="w-7 shrink-0" />}
      {onOpen && !node.disabled ? <button type="button" onClick={() => onOpen(node)} title={node.name} aria-label={`Open ${node.name}`}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md pe-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}</button>
        : <span title={node.name} className={cn("flex min-h-8 min-w-0 flex-1 items-center gap-2 pe-2 text-[13px]", node.disabled && "text-muted-foreground")}>{label}</span>}
    </div>
    {folder && expanded && <ul id={id} className="ms-3.5 flex min-w-0 flex-col border-s border-border/60 ps-2">
      {children.length ? children.map((child) => <TreeBranch key={child.node.path} branch={child} onOpen={onOpen} defaultExpanded={false} />) : <li className="px-3 py-1.5 text-xs text-muted-foreground">No items shown</li>}
    </ul>}
  </li>;
}

export function FileTree({ nodes, visibleCount = nodes.length, totalAdditions = 0, totalDeletions = 0, title, onOpen, hasMore = false, className, ...props }: Omit<ComponentProps<"div">, "children" | "onOpen"> & {
  nodes: readonly FileTreeNode[];
  visibleCount?: number;
  totalAdditions?: number;
  totalDeletions?: number;
  title?: string;
  onOpen?: (node: FileTreeNode) => void;
  hasMore?: boolean;
}) {
  const roots = useMemo(() => branches(nodes.slice(0, visibleCount)), [nodes, visibleCount]);
  const files = nodes.filter((node) => node.kind === "file").length;
  return <div data-slot="file-tree" className={cn(paper, "flex w-full min-w-0 max-w-sm flex-col gap-2 rounded-2xl p-3", className)} {...props}>
    <div className="flex items-baseline justify-between gap-2 px-1"><span className="text-[13px] font-medium">{title ?? `${files} files`}</span>{Boolean(totalAdditions || totalDeletions) && <span className={cn(mono, "tabular-nums")}>+{totalAdditions} −{totalDeletions}</span>}</div>
    <ul aria-label={title ?? "Files"} className="max-h-80 overflow-auto">{roots.map((branch) => <TreeBranch key={branch.node.path} branch={branch} onOpen={onOpen} defaultExpanded={false} />)}</ul>
    {!nodes.length && <p className="px-1 py-2 text-xs text-muted-foreground">No accessible items in this view.</p>}
    {(hasMore || visibleCount < nodes.length) && <p className="px-1 text-xs leading-relaxed text-muted-foreground">Partial view. Ask to explore a specific folder for more items.</p>}
  </div>;
}
