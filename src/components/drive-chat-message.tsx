"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { MessagePrimitive, useAuiState, type TextMessagePartComponent } from "@assistant-ui/react";
import { BookOpenText, FileDiff, Scale, Search } from "lucide-react";
import type { DriveChatCitation, DriveChatStep, DriveItem } from "@/lib/drive-types";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { CodeDiff } from "@/components/assistant-ui/elements/code-diff";
import { ComparisonCard } from "@/components/assistant-ui/elements/comparison-card";
import { ComposerAttachmentChip } from "@/components/assistant-ui/elements/composer";
import { DayDivider, MessageTime } from "@/components/assistant-ui/elements/day-separator";
import { DocumentReference } from "@/components/assistant-ui/elements/document-reference";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { FileTree, type FileTreeNode } from "@/components/assistant-ui/elements/file-tree";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { MessageActions } from "@/components/assistant-ui/elements/message-actions";
import { AssistantReply, UserBubble } from "@/components/assistant-ui/elements/message-pair";
import { Sources } from "@/components/assistant-ui/elements/sources";
import { ToolCall } from "@/components/assistant-ui/elements/tool-call";
import { ToolError } from "@/components/assistant-ui/elements/tool-error";
import { ToolTimeline, type TimelineStep } from "@/components/assistant-ui/elements/tool-timeline";
import { cn } from "@/lib/utils";

/** A message in the sheet: saved on the server, or the question and answer still streaming. */
export type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  citations: DriveChatCitation[];
  steps: DriveChatStep[];
  attachments: { name: string; size: number; kind: "image" | "text" | "archive" }[];
  feedback: "up" | "down" | null;
  status: "running" | "complete" | "error";
  error?: string;
  /** Names of members @mentioned in the question, for highlighting. */
  mentions?: string[];
};

export type ChatMessageContext = {
  byId: ReadonlyMap<string, ChatEntry>;
  /** The newest assistant answer: the only one that can be regenerated. */
  lastAssistantId: string | null;
  running: boolean;
  regeneratingId: string | null;
  searchHitId: string | null;
  onOpenItem: (item: DriveItem) => void;
  onRegenerate: () => void;
  onFeedback: (messageId: string, feedback: "up" | "down" | null) => void;
};

const MessageContext = createContext<ChatMessageContext | null>(null);
export const ChatMessageProvider = MessageContext.Provider;

function useChatMessage() {
  const context = useContext(MessageContext);
  const id = useAuiState((state) => state.message.id);
  if (!context) throw new Error("Chat messages need ChatMessageProvider.");
  return { context, entry: context.byId.get(id) };
}

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
export function dayLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return dayFormat.format(date);
}

/** [n] markers become in-page links that the Markdown renderer turns into source buttons. */
export function linkCitations(text: string, citations: DriveChatCitation[]) {
  const known = new Set(citations.map((citation) => citation.n));
  return text.replace(/\[(\d{1,3})\](?!\()/g, (marker, n: string) => known.has(Number(n)) ? `[${n}](#source-${n})` : marker);
}

/** Source markers inside the answer. Other links from the model are shown as text: file contents are untrusted. */
const CitedMarkdownText: TextMessagePartComponent = () => {
  const { context, entry } = useChatMessage();
  const citations = entry?.citations ?? [];
  return <MarkdownText components={{
    a: ({ href, children }) => {
      const citation = href?.startsWith("#source-") ? citations.find((candidate) => `#source-${candidate.n}` === href) : undefined;
      if (!citation) return <span>{children}</span>;
      const item = citation.item;
      return item
        ? <button type="button" onClick={() => context.onOpenItem(item)} aria-label={`Source ${citation.n}: ${citation.name}`}
          className="mx-0.5 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded bg-foreground/[0.06] px-1 align-text-top text-[11px] font-medium tabular-nums text-foreground/55 outline-none hover:bg-foreground/[0.1] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{citation.n}</button>
        : <span className="mx-0.5 rounded bg-foreground/[0.04] px-1 text-[11px] tabular-nums text-foreground/35" title="No longer available">{citation.n}</span>;
    },
  }} />;
};

/** Search terms of an answer's question stay readable; mentioned members stand out. */
function MentionText({ text, mentions }: { text: string; mentions: string[] }) {
  if (!mentions.length) return <>{text}</>;
  const pattern = new RegExp(`(${mentions.map((name) => `@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).join("|")})`, "g");
  return <>{text.split(pattern).map((part, index) => index % 2 ? <span key={index} className="font-medium text-blue-600 dark:text-blue-400">{part}</span> : part)}</>;
}

function useDayDivider(entry: ChatEntry | undefined) {
  const index = useAuiState((state) => state.message.index);
  const previous = useAuiState((state) => state.thread.messages[index - 1]?.id);
  const { context } = useChatMessage();
  if (!entry) return null;
  const before = previous ? context.byId.get(previous) : undefined;
  return !before || dayLabel(before.createdAt) !== dayLabel(entry.createdAt) ? dayLabel(entry.createdAt) : null;
}

export function ChatUserMessage() {
  const { context, entry } = useChatMessage();
  const day = useDayDivider(entry);
  if (!entry) return null;
  return <MessagePrimitive.Root id={`chat-message-${entry.id}`} className="flex flex-col gap-2">
    {day && <DayDivider day={day} />}
    <div className={cn("group flex flex-row-reverse items-baseline gap-2", context.searchHitId === entry.id && "[&_[data-slot=user-bubble]]:ring-2 [&_[data-slot=user-bubble]]:ring-amber-400/60")}>
      <UserBubble className="whitespace-pre-wrap break-words"><MentionText text={entry.content} mentions={entry.mentions ?? []} /></UserBubble>
      <MessageTime time={timeFormat.format(new Date(entry.createdAt))} />
    </div>
    {entry.attachments.length > 0 && <div className="flex flex-wrap justify-end gap-2">
      {entry.attachments.map((file) => <ComposerAttachmentChip key={file.name} attachment={{ name: file.name, meta: `${Math.max(1, Math.round(file.size / 1024))} KB`, state: "done", kind: file.kind }} />)}
    </div>}
  </MessagePrimitive.Root>;
}

const STEP_VERBS: Record<DriveChatStep["tool"], { verb: string; active: string; icon: TimelineStep["icon"] }> = {
  search_drive: { verb: "Searched", active: "Searching", icon: Search },
  read_file_excerpt: { verb: "Read", active: "Reading", icon: BookOpenText },
  compare_versions: { verb: "Compared versions of", active: "Comparing versions of", icon: FileDiff },
  present_comparison: { verb: "Weighed", active: "Weighing", icon: Scale },
};

function stepsLabel(steps: DriveChatStep[]) {
  const searches = steps.filter((step) => step.tool === "search_drive").length;
  const reads = steps.filter((step) => step.tool === "read_file_excerpt").length;
  const parts = [
    searches && `searched ${searches === 1 ? "once" : `${searches} times`}`,
    reads && `read ${reads} ${reads === 1 ? "file" : "files"}`,
    steps.some((step) => step.tool === "compare_versions") && "compared versions",
    steps.some((step) => step.tool === "present_comparison") && "weighed options",
  ].filter(Boolean).join(", ");
  return parts ? parts[0].toUpperCase() + parts.slice(1) : "Worked";
}

/** The turn's tool work: one call as a disclosure, several as a timeline. */
function Steps({ steps, running }: { steps: DriveChatStep[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const work = steps.filter((step) => step.status !== "error");
  if (!work.length) return null;
  const active = work.findLast((step) => step.status === "running");
  if (work.length === 1 && work[0].tool === "search_drive") {
    const step = work[0];
    return <ToolCall label="Searched your files" activeLabel="Searching your files" query={step.label}
      request={`search_drive(“${step.label}”)`} result={step.summary ?? "…"} running={step.status === "running"} open={open} onOpenChange={setOpen} className="max-w-none" />;
  }
  return <ToolTimeline
    steps={work.map((step) => ({ verb: STEP_VERBS[step.tool].verb, chip: step.label, icon: STEP_VERBS[step.tool].icon }))}
    visibleSteps={work.length} streaming={running && Boolean(active)} open={open} onOpenChange={setOpen}
    restingLabel={stepsLabel(work)} activeLabel={active ? `${STEP_VERBS[active.tool].active} ${active.label}` : "Working"}
    stats={work.flatMap((step) => step.diff ? [{ file: step.diff.filename, added: step.diff.additions, removed: step.diff.deletions }] : [])}
    className="max-w-none" />;
}

/** Where the sources live, as a small tree of their (readable) folders. */
function sourceTree(citations: DriveChatCitation[]): FileTreeNode[] {
  const nodes: FileTreeNode[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    if (!citation.item) continue;
    const folders = citation.path.length ? citation.path : ["My drive"];
    folders.forEach((name, depth) => {
      const path = folders.slice(0, depth + 1).join("/");
      if (!seen.has(path)) { seen.add(path); nodes.push({ path, name, depth, kind: "folder" }); }
    });
    const path = `${folders.join("/")}/${citation.itemId}`;
    if (!seen.has(path)) { seen.add(path); nodes.push({ path, name: citation.name, depth: folders.length, kind: "file" }); }
  }
  return nodes;
}

/** Cited documents with their quoted passages, grouped per file; unavailable files have none. */
function DocumentReferences({ citations, onOpen }: { citations: DriveChatCitation[]; onOpen: (item: DriveItem) => void }) {
  const files = [...new Map(citations.filter((citation) => citation.item && citation.quote).map((citation) => [citation.itemId, citation])).values()];
  return <>{files.map((file) => {
    const anchors = citations.filter((citation) => citation.itemId === file.itemId && citation.quote).map((citation) => {
      const page = /^page (\d+)$/.exec(citation.location ?? "")?.[1];
      return { page: page ? Number(page) : citation.n, label: page ? undefined : citation.location ?? `source ${citation.n}`, quote: citation.quote! };
    });
    return <DocumentReference key={file.itemId} title={file.name} anchors={anchors} activePage={-1} onJump={() => onOpen(file.item!)} className="max-w-none" />;
  })}</>;
}

export function ChatAssistantMessage() {
  const { context, entry } = useChatMessage();
  const [copied, setCopied] = useState(false);
  const [details, setDetails] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  if (!entry) return null;
  const running = entry.status === "running";
  const failedSteps = entry.steps.filter((step) => step.status === "error");
  const canRegenerate = entry.id === context.lastAssistantId && !context.running;
  const regenerating = context.regeneratingId === entry.id;
  const tree = sourceTree(entry.citations);
  return <MessagePrimitive.Root id={`chat-message-${entry.id}`} className={cn("rounded-2xl", context.searchHitId === entry.id && "ring-2 ring-amber-400/60 ring-offset-4 ring-offset-background")}>
    <AssistantReply className="gap-3">
      <Steps steps={entry.steps} running={running} />
      {failedSteps.map((step) => <ToolError key={step.id} name={step.tool} target={step.label} message={step.error ?? "The tool failed."} attempt={1} maxAttempts={1}
        retrying={regenerating} onRetry={canRegenerate ? context.onRegenerate : undefined} className="max-w-none" />)}
      {running && !entry.content && !entry.steps.some((step) => step.status === "running") && <AwaitingFirstToken />}
      {entry.content && <div className="w-full break-words"><MessagePrimitive.Parts components={{ Text: CitedMarkdownText }} /></div>}
      {entry.steps.flatMap((step) => step.comparison ? [<ComparisonCard key={step.id} {...step.comparison} className="max-w-none" />] : [])}
      {entry.steps.flatMap((step) => step.diff && step.diff.lines.length ? [<CodeDiff key={step.id} filename={step.diff.filename} additions={step.diff.additions} deletions={step.diff.deletions} lines={step.diff.lines} cycle={0} className="max-w-none" />] : [])}
      {entry.status === "error" && <ErrorState title="The answer didn't finish" detail={entry.error ?? "Please try again."} retrying={regenerating} onRetry={canRegenerate ? context.onRegenerate : () => {}} className="max-w-none" />}
      {entry.citations.length > 0 && <Sources open={sourcesOpen} onOpenChange={setSourcesOpen} className="max-w-none"
        sources={entry.citations.map((citation) => ({
          id: String(citation.n),
          domain: citation.item ? (citation.path.length ? citation.path.join(" / ") : "My drive") : "No longer available",
          title: `${citation.n}. ${citation.name}${citation.location ? ` · ${citation.location}` : ""}`,
          disabled: !citation.item,
          onSelect: citation.item ? () => context.onOpenItem(citation.item!) : undefined,
        }))} />}
      {!running && entry.status !== "error" && <MessageActions data-hover-actions
        copied={copied} reaction={entry.feedback} regenerating={regenerating}
        onCopy={() => { void navigator.clipboard.writeText(entry.content).then(() => setCopied(true)); }}
        onReactionChange={(reaction) => context.onFeedback(entry.id, reaction)}
        onRegenerate={canRegenerate ? context.onRegenerate : () => {}}
        onMore={() => setDetails((open) => !open)}
        className={cn(details && "opacity-100!", !canRegenerate && "[&_[aria-label='Regenerate response']]:hidden")} />}
      {details && <div className="flex w-full flex-col gap-2">
        <DocumentReferences citations={entry.citations} onOpen={context.onOpenItem} />
        {tree.length > 0 && <FileTree nodes={tree} visibleCount={tree.length} totalAdditions={0} totalDeletions={0} title="Where the sources are" className="max-w-none" />}
        {!tree.length && !entry.citations.some((citation) => citation.quote) && <p className="text-xs text-foreground/40">No sources you can open for this answer.</p>}
      </div>}
    </AssistantReply>
  </MessagePrimitive.Root>;
}

function AwaitingFirstToken() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 120);
    return () => window.clearInterval(timer);
  }, []);
  return <GenerationLoader label="Thinking" tick={tick} className="items-start py-1" />;
}
