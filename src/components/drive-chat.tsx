"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AssistantRuntimeProvider, useAuiState, useExternalStoreRuntime, type AppendMessage, type ExternalStoreThreadListAdapter, type ThreadMessageLike, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { deleteChat, renameChat } from "@/app/actions/chat";
import { getChat, listChats } from "@/lib/drive-read-client";
import type { ChatStreamEvent, DriveChatCitation, DriveChatMessage, DriveItem } from "@/lib/drive-types";
import { Thread, type ThreadComponents } from "@/components/assistant-ui/thread.aui";
import { ThreadList } from "@/components/assistant-ui/thread-list.aui";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/spinner";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/** A message in this view: saved on the server, or the question and answer still streaming. */
type ChatEntry = Omit<DriveChatMessage, "createdAt"> & { searches: string[]; status: "running" | "complete" | "error"; error?: string };

/** Streams one answer from /api/drive/chat, calling `onEvent` for each NDJSON line. */
async function streamAnswer(input: { chatId: string | null; message: string; userMessageId: string; assistantMessageId: string }, onEvent: (event: ChatStreamEvent) => void, signal: AbortSignal) {
  const response = await fetch("/api/drive/chat", {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", "X-Orole-Chat": "1" },
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    const body: unknown = await response.json().catch(() => null);
    throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "The question could not be sent. Please try again.");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event: ChatStreamEvent = JSON.parse(line);
      onEvent(event);
    }
  }
}

/** [n] markers become in-page links that the Markdown renderer turns into source buttons. */
function linkCitations(text: string, citations: DriveChatCitation[]) {
  const known = new Set(citations.map((citation) => citation.n));
  return text.replace(/\[(\d{1,3})\](?!\()/g, (marker, n: string) => known.has(Number(n)) ? `[${n}](#source-${n})` : marker);
}

function convertMessage(entry: ChatEntry): ThreadMessageLike {
  if (entry.role === "user") return { id: entry.id, role: "user", content: [{ type: "text", text: entry.content }] };
  const finished = entry.status !== "running";
  return {
    id: entry.id, role: "assistant",
    content: [
      ...entry.searches.map((query, index) => ({
        type: "tool-call" as const, toolCallId: `${entry.id}-search-${index}`, toolName: "search_drive", args: { query },
        // A search is done once the model moved on: a later search, answer text, or the end of the turn.
        result: finished || index < entry.searches.length - 1 || entry.content ? "done" : undefined,
      })),
      ...(entry.content ? [{ type: "text" as const, text: linkCitations(entry.content, entry.citations) }] : []),
    ],
    status: entry.status === "running" ? { type: "running" } : entry.status === "error" ? { type: "incomplete", reason: "error", error: entry.error ?? "The answer could not be completed." } : { type: "complete", reason: "stop" },
  };
}

type CitationLookup = { byMessage: ReadonlyMap<string, DriveChatCitation[]>; onOpen: (item: DriveItem) => void };
const CitationsContext = createContext<CitationLookup>({ byMessage: new Map(), onOpen: () => {} });

function useMessageCitations() {
  const { byMessage, onOpen } = useContext(CitationsContext);
  const messageId = useAuiState((state) => state.message.id);
  return { citations: byMessage.get(messageId) ?? [], onOpen };
}

/** Source markers inside the answer. Other links from the model are shown as text: file contents are untrusted. */
function CitedMarkdownText() {
  const { citations, onOpen } = useMessageCitations();
  return <MarkdownText components={{
    a: ({ href, children }) => {
      const citation = href?.startsWith("#source-") ? citations.find((entry) => `#source-${entry.n}` === href) : undefined;
      if (!citation) return <span>{children}</span>;
      const item = citation.item;
      return item
        ? <button type="button" onClick={() => onOpen(item)} aria-label={`Source ${citation.n}: ${citation.name}`}
          className="mx-0.5 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded bg-muted px-1 align-text-top text-[11px] font-medium tabular-nums text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{citation.n}</button>
        : <span className="mx-0.5 rounded bg-muted px-1 text-[11px] tabular-nums text-muted-foreground/70" title="No longer available">{citation.n}</span>;
    },
  }} />;
}

/** Every source of an answer, re-authorized on load: ones this member can no longer open are marked. */
function ChatSources() {
  const { citations, onOpen } = useMessageCitations();
  if (!citations.length) return null;
  return <ul aria-label="Sources" className="mt-3 flex flex-wrap gap-1.5">
    {citations.map((citation) => {
      const label = `${citation.name}${citation.location ? ` · ${citation.location}` : ""}`;
      const item = citation.item;
      return <li key={citation.n} className="max-w-full">
        {item
          ? <button type="button" onClick={() => onOpen(item)} aria-label={`Source ${citation.n}: open ${label}`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
            <span className="tabular-nums text-muted-foreground">{citation.n}</span><span className="truncate">{label}</span>
          </button>
          : <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground">
            <span className="tabular-nums">{citation.n}</span><span className="truncate line-through">{label}</span><Badge variant="secondary">No longer available</Badge>
          </span>}
      </li>;
    })}
  </ul>;
}

const SearchStep: ToolCallMessagePartComponent = ({ args, result }) => {
  const query = typeof args.query === "string" ? args.query : "";
  return <p className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground">
    {result === undefined ? <Spinner size={12} label="Searching" /> : <Search className="size-3.5" aria-hidden="true" />}
    {result === undefined ? "Searching your files for" : "Searched your files for"} “{query}”
  </p>;
};

function SearchSteps({ children }: PropsWithChildren) {
  return <div className="mb-2 flex flex-col">{children}</div>;
}

function Welcome() {
  return <div className="mb-6 flex flex-col gap-1.5 px-2">
    <p className="text-2xl font-medium tracking-tight">What would you like to know?</p>
    <p className="max-w-md text-sm text-muted-foreground">Ask about anything in your files. Password-protected and excluded folders are never searched.</p>
  </div>;
}

const threadComponents: ThreadComponents = {
  Welcome, Text: CitedMarkdownText, MessageFooter: ChatSources, ToolFallback: SearchStep, ToolGroup: SearchSteps,
  placeholder: "Ask a question about your files…",
};

/** "Ask your drive": assistant-ui thread and history over the member's private, server-saved chats. */
export function DriveChatView({ onOpenItem }: { onOpenItem: (item: DriveItem) => void }) {
  const client = useQueryClient();
  const [chatId, setChatId] = useState<string | null>(null);
  const [pending, setPending] = useState<ChatEntry[] | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; title: string; resolve: () => void } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const chats = useQuery({
    queryKey: ["drive-chats"],
    queryFn: async ({ signal }) => {
      const result = await listChats(signal);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    staleTime: 30_000,
  });
  const chat = useQuery({
    queryKey: ["drive-chat", chatId],
    queryFn: async ({ signal }) => {
      const result = await getChat(chatId!, signal);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    enabled: Boolean(chatId),
    // Citations are re-authorized on every load; never reuse an old access decision.
    staleTime: 0,
  });

  const saved = useMemo<ChatEntry[]>(() => (chatId ? chat.data?.messages ?? [] : []).map((message) => ({ ...message, searches: [], status: "complete" })), [chatId, chat.data]);
  // The question is saved before its answer streams; while a draft exists, it replaces the saved copy.
  const messages = useMemo(() => {
    if (!pending) return saved;
    const drafts = new Set(pending.map((entry) => entry.id));
    return [...saved.filter((entry) => !drafts.has(entry.id)), ...pending];
  }, [saved, pending]);
  const citations = useMemo<CitationLookup>(() => ({ byMessage: new Map(messages.map((message) => [message.id, message.citations])), onOpen: onOpenItem }), [messages, onOpenItem]);

  function switchTo(id: string | null) {
    abort.current?.abort();
    setPending(null);
    setIsRunning(false);
    setChatId(id);
  }

  async function onNew(message: AppendMessage) {
    const part = message.content[0];
    const text = part?.type === "text" ? part.text.trim() : "";
    if (!text) return;
    // The server saves both messages under these ids, so the refetched thread continues this one exactly.
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const update = (change: (entry: ChatEntry) => ChatEntry) => setPending((current) => current && current.map((entry) => entry.id === assistantId ? change(entry) : entry));
    setPending([
      { id: userId, role: "user", content: text, citations: [], searches: [], status: "complete" },
      { id: assistantId, role: "assistant", content: "", citations: [], searches: [], status: "running" },
    ]);
    setIsRunning(true);
    const controller = new AbortController();
    abort.current = controller;
    let target = chatId;
    let failed = false;
    try {
      await streamAnswer({ chatId, message: text, userMessageId: userId, assistantMessageId: assistantId }, (event) => {
        if (event.type === "chat") {
          target = event.chatId;
          setChatId(event.chatId);
          void client.invalidateQueries({ queryKey: ["drive-chats"] });
        } else if (event.type === "searching") update((entry) => ({ ...entry, searches: [...entry.searches, event.query] }));
        else if (event.type === "text") update((entry) => ({ ...entry, content: entry.content + event.delta }));
        else if (event.type === "error") {
          failed = true;
          update((entry) => ({ ...entry, status: "error", error: event.message }));
        }
      }, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      failed = true;
      update((entry) => ({ ...entry, status: "error", error: error instanceof Error ? error.message : "The question could not be sent." }));
    } finally {
      if (abort.current === controller) setIsRunning(false);
    }
    // The saved answer, with citations checked against current access, replaces the streamed draft.
    if (target) await client.invalidateQueries({ queryKey: ["drive-chat", target] });
    void client.invalidateQueries({ queryKey: ["drive-chats"] });
    if (!failed) setPending(null);
  }

  const threadList: ExternalStoreThreadListAdapter = {
    threadId: chatId ?? undefined,
    isLoading: chats.isPending,
    threads: (chats.data ?? []).map((entry) => ({ id: entry.id, status: "regular", title: entry.title })),
    onSwitchToNewThread: () => switchTo(null),
    onSwitchToThread: (id) => switchTo(id),
    onRename: async (id, title) => {
      const result = await renameChat({ id, title });
      if (!result.success) toast.error(result.error);
      void client.invalidateQueries({ queryKey: ["drive-chats"] });
    },
    // The list only drops a chat once it is deleted on the server, after the member confirms.
    onDelete: (id) => new Promise<void>((resolve) => setDeleting({ id, title: chats.data?.find((entry) => entry.id === id)?.title ?? "this chat", resolve })),
  };

  const runtime = useExternalStoreRuntime<ChatEntry>({
    messages, convertMessage, isRunning, onNew,
    isLoading: Boolean(chatId) && chat.isPending && !pending,
    onCancel: async () => { abort.current?.abort(); setIsRunning(false); setPending((current) => current && current.map((entry) => entry.status === "running" ? { ...entry, status: "error", error: "Stopped." } : entry)); },
    adapters: { threadList },
  });

  async function confirmDelete() {
    if (!deleting) return;
    const result = await deleteChat(deleting.id);
    if (!result.success) toast.error(result.error);
    else {
      if (deleting.id === chatId) switchTo(null);
      client.removeQueries({ queryKey: ["drive-chat", deleting.id] });
      await client.invalidateQueries({ queryKey: ["drive-chats"] });
      toast.success("Chat deleted");
    }
    deleting.resolve();
    setDeleting(null);
  }

  return <AssistantRuntimeProvider runtime={runtime}>
    <CitationsContext.Provider value={citations}>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <aside aria-label="Chats" className="max-h-36 shrink-0 overflow-y-auto border-b border-border/70 p-2 sm:max-h-none sm:w-56 sm:border-r sm:border-b-0">
          <ThreadList />
        </aside>
        <section aria-label="Conversation" className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {chat.isError && chatId ? <p role="alert" className="p-4 text-sm text-destructive">{chat.error.message}</p> : <Thread components={threadComponents} />}
        </section>
      </div>
    </CitationsContext.Provider>
    {deleting && <AlertDialog open onOpenChange={(open) => { if (!open) { deleting.resolve(); setDeleting(null); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">Delete “{deleting.title}”?</AlertDialogTitle>
          <AlertDialogDescription>The questions, answers and quoted passages in this chat are removed permanently.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={(event) => { event.preventDefault(); void confirmDelete(); }}>Delete chat</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>}
  </AssistantRuntimeProvider>;
}

/**
 * Ask AI in a right-hand sheet. It stays mounted while closed, so a streaming answer and the open
 * chat survive closing it. A cited file opens only once the sheet has finished closing, so the two
 * modals never overlap mid-animation.
 */
export function AskAiSheet({ open, onOpenChange, onOpenItem }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenItem: (item: DriveItem) => void }) {
  const [opening, setOpening] = useState<DriveItem | null>(null);
  const openSource = (item: DriveItem) => {
    setOpening(item);
    onOpenChange(false);
  };
  return <Sheet open={open} onOpenChange={onOpenChange} onOpenChangeComplete={(isOpen) => {
    if (isOpen || !opening) return;
    setOpening(null);
    onOpenItem(opening);
  }}>
    <SheetContent side="right" keepMounted className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
      <SheetHeader className="border-b border-border/70 pr-12">
        <SheetTitle>Ask AI</SheetTitle>
        <SheetDescription>Answers from files you can open, with sources. Chats are private to you.</SheetDescription>
      </SheetHeader>
      <DriveChatView onOpenItem={openSource} />
    </SheetContent>
  </Sheet>;
}
