"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AssistantRuntimeProvider, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { ChevronDown, Ellipsis, Maximize2, Minimize2, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { deleteChat, renameChat, setChatFeedback } from "@/app/actions/chat";
import { approveChatAction } from "@/app/actions/chat-mutations";
import { getChat, listChats } from "@/lib/drive-read-client";
import { invalidateDriveMetadata } from "@/lib/drive-cache";
import type { ChatStreamEvent, DriveChat, DriveChatStep, DriveItem } from "@/lib/drive-types";
import { ConversationSearch, type SearchHit } from "@/components/assistant-ui/elements/conversation-search";
import { EmptyState, EmptyStateGreeting, EmptyStateSuggestion, EmptyStateSuggestions } from "@/components/assistant-ui/elements/empty-state";
import { PermissionGrant, type GrantScope } from "@/components/assistant-ui/elements/permission-grant";
import { ghostButton } from "@/components/assistant-ui/elements/surfaces";
import { ThreadSearch } from "@/components/assistant-ui/elements/thread-search";
import { ChatAssistantMessage, ChatMessageProvider, ChatUserMessage, dayLabel, linkCitations, type ChatEntry, type ChatMessageContext } from "@/components/drive-chat-message";
import { ChatComposer, type ComposerSubmission, type OutgoingAttachment } from "@/components/drive-chat-composer";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const SUGGESTIONS = ["What did I upload this week?", "Find my latest invoices", "Summarize the documents in my shared folders"];

/** Streams one answer from /api/drive/chat, calling `onEvent` for each NDJSON line. */
async function streamAnswer(input: Record<string, unknown>, onEvent: (event: ChatStreamEvent) => void, signal: AbortSignal) {
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

// Consent to send passages to the model: "always" is remembered on this device, "session" for this tab.
const CONSENT_KEY = "orole.ask-ai.consent";
const consentListeners = new Set<() => void>();
function readConsent(): GrantScope | "pending" {
  const value = localStorage.getItem(CONSENT_KEY) ?? sessionStorage.getItem(CONSENT_KEY);
  return value === "always" || value === "session" || value === "denied" ? value : "pending";
}
function writeConsent(scope: GrantScope | "pending") {
  localStorage.removeItem(CONSENT_KEY);
  sessionStorage.removeItem(CONSENT_KEY);
  if (scope === "always") localStorage.setItem(CONSENT_KEY, scope);
  else if (scope !== "pending") sessionStorage.setItem(CONSENT_KEY, scope);
  consentListeners.forEach((listener) => listener());
}
function useConsent() {
  return useSyncExternalStore((listener) => { consentListeners.add(listener); return () => consentListeners.delete(listener); }, readConsent, () => "pending" as const);
}

function convertMessage(entry: ChatEntry): ThreadMessageLike {
  if (entry.role === "user") return { id: entry.id, role: "user", content: [{ type: "text", text: entry.content }] };
  return {
    id: entry.id, role: "assistant",
    content: entry.content ? [{ type: "text", text: linkCitations(entry.content, entry.citations) }] : [],
    status: entry.status === "running" ? { type: "running" } : entry.status === "error" ? { type: "incomplete", reason: "error", error: entry.error ?? "" } : { type: "complete", reason: "stop" },
  };
}

function ThreadMessage() {
  const role = useAuiState((state) => state.message.role);
  return role === "user" ? <ChatUserMessage /> : <ChatAssistantMessage />;
}

/** Ctrl/⌘ F inside the sheet: every text match across the thread, stepped through in order. */
function useConversationSearch(messages: ChatEntry[]) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const hits = useMemo<(SearchHit & { messageId: string })[]>(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const found: (SearchHit & { messageId: string })[] = [];
    messages.forEach((message, index) => {
      // Search what the reader sees, not Markdown syntax or citation markers.
      const text = message.content.replace(/[*_`#>]+/g, "").replace(/\[(\d{1,3})\]/g, "");
      for (let at = text.toLowerCase().indexOf(needle); at >= 0 && found.length < 200; at = text.toLowerCase().indexOf(needle, at + needle.length)) {
        found.push({
          id: `${message.id}-${at}`, messageId: message.id,
          before: `${at > 40 ? "…" : ""}${text.slice(Math.max(0, at - 40), at)}`, match: text.slice(at, at + needle.length), after: `${text.slice(at + needle.length, at + needle.length + 60)}…`,
          position: messages.length > 1 ? (index / (messages.length - 1)) * 96 : 0,
        });
      }
    });
    return found;
  }, [messages, query]);
  const current = hits.length ? hits[Math.min(active, hits.length - 1)] : undefined;
  useEffect(() => {
    if (current) document.getElementById(`chat-message-${current.messageId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [current]);
  return {
    open, query, hits, active: Math.min(active, Math.max(0, hits.length - 1)), activeMessageId: open ? current?.messageId ?? null : null,
    show: () => setOpen(true), hide: () => { setOpen(false); setQuery(""); },
    setQuery: (next: string) => { setQuery(next); setActive(0); },
    step: (delta: number) => setActive((index) => hits.length ? (index + delta + hits.length) % hits.length : 0),
  };
}

/** "now", "12m", "3h", "9d": how long ago a chat was last active. */
function relativeAge(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

/** Today / Yesterday / Earlier buckets for the history popover. */
function historyGroup(iso: string) {
  const label = dayLabel(iso);
  return label === "Today" || label === "Yesterday" ? label : Date.now() - new Date(iso).getTime() < 7 * 86_400_000 ? "This week" : "Earlier";
}

/**
 * Ask AI: a right-hand sheet with the member's private chats. It stays mounted while closed, so an answer
 * keeps streaming; a cited file opens once the sheet has finished closing so the two modals never overlap.
 */
export function AskAiSheet({ open, onOpenChange, onOpenItem }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenItem: (item: DriveItem) => void }) {
  const client = useQueryClient();
  const consent = useConsent();
  const [wide, setWide] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [pending, setPending] = useState<ChatEntry[] | null>(null);
  const [hiddenId, setHiddenId] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, "up" | "down" | null>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [opening, setOpening] = useState<DriveItem | null>(null);
  const [retainedAttachments, setRetainedAttachments] = useState<ReadonlyMap<string, OutgoingAttachment>>(() => new Map());
  const [composerKey, setComposerKey] = useState(0);
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

  const messages = useMemo<ChatEntry[]>(() => {
    const saved: ChatEntry[] = (chatId ? chat.data?.messages ?? [] : []).map((message) => ({ ...message, feedback: feedback[message.id] !== undefined ? feedback[message.id] : message.feedback, status: "complete", persisted: true }));
    const drafts = new Set((pending ?? []).map((entry) => entry.id));
    return [...saved.filter((entry) => !drafts.has(entry.id) && entry.id !== hiddenId), ...(pending ?? [])];
  }, [chatId, chat.data, pending, hiddenId, feedback]);
  const search = useConversationSearch(messages);
  const title = chatId ? chats.data?.find((entry) => entry.id === chatId)?.title ?? chat.data?.title ?? "Chat" : "New chat";

  function switchTo(id: string | null) {
    abort.current?.abort();
    abort.current = null;
    setRegeneratingId(null);
    setPending(null);
    setHiddenId(null);
    setRunning(false);
    setChatId(id);
    setHistoryOpen(false);
    setComposerKey((key) => key + 1);
    search.hide();
  }

  async function run(input: Record<string, unknown>, entries: ChatEntry[], assistantId: string) {
    abort.current?.abort();
    const update = (change: (entry: ChatEntry) => ChatEntry) => setPending((current) => current && current.map((entry) => entry.id === assistantId ? change(entry) : entry));
    setPending(entries);
    setRunning(true);
    const controller = new AbortController();
    abort.current = controller;
    let target = chatId;
    let failed = false;
    try {
      await streamAnswer({ ...input, chatId, assistantMessageId: assistantId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, (event) => {
        if (controller.signal.aborted || abort.current !== controller || failed) return;
        if (event.type === "chat") {
          target = event.chatId;
          setChatId(event.chatId);
          void client.invalidateQueries({ queryKey: ["drive-chats"] });
        } else if (event.type === "step") {
          update((entry) => {
            const steps: DriveChatStep[] = entry.steps.some((step) => step.id === event.step.id) ? entry.steps.map((step) => step.id === event.step.id ? event.step : step) : [...entry.steps, event.step];
            return { ...entry, steps };
          });
        } else if (event.type === "text") update((entry) => ({ ...entry, content: entry.content + event.delta }));
        else if (event.type === "error") {
          failed = true;
          update((entry) => ({ ...entry, status: "error", error: event.message }));
          setRunning(false);
        }
      }, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      failed = true;
      update((entry) => ({ ...entry, status: "error", error: error instanceof Error ? error.message : "The question could not be sent." }));
    } finally {
      if (abort.current === controller) {
        update((entry) => entry.status === "running" ? { ...entry, status: "complete" } : entry);
        setRunning(false);
        setRegeneratingId(null);
      }
    }
    // The saved answer, with citations checked against current access, replaces the streamed draft.
    if (target) await client.invalidateQueries({ queryKey: ["drive-chat", target] });
    void client.invalidateQueries({ queryKey: ["drive-chats"] });
    if (!failed && abort.current === controller) { setPending(null); setHiddenId(null); }
  }

  const draftAssistant = (id: string): ChatEntry => ({ id, role: "assistant", content: "", createdAt: new Date().toISOString(), citations: [], steps: [], attachments: [], feedback: null, status: "running" });

  function send({ text, mentions, attachments }: ComposerSubmission) {
    if (running || consent === "pending" || consent === "denied") return false;
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    if (attachments.length) setRetainedAttachments((current) => {
      const next = new Map(current);
      for (const attachment of attachments) next.set(attachment.id, attachment);
      return next;
    });
    void run({ message: text, userMessageId: userId, mentionIds: mentions.map((member) => member.id), attachments: attachments.map(({ id, name, mimeType, data }) => ({ id, name, mimeType, data })) }, [
      { id: userId, role: "user", content: text, createdAt: new Date().toISOString(), citations: [], steps: [], attachments: attachments.map(({ id, name, size, kind, mimeType }) => ({ id, name, size, kind, mimeType })), feedback: null, status: "complete", mentions: mentions.map((member) => member.name) },
      draftAssistant(assistantId),
    ], assistantId);
    return true;
  }

  function regenerate() {
    const last = messages.findLast((entry) => entry.role === "assistant");
    if (!chatId || running || !last || last.steps.some((step) => step.approval?.status === "executing" || step.approval?.status === "completed")) return;
    const assistantId = crypto.randomUUID();
    setRegeneratingId(last.id);
    setHiddenId(last.id);
    void run({ regenerate: true }, [draftAssistant(assistantId)], assistantId);
  }

  function stop() {
    abort.current?.abort();
    abort.current = null;
    setRegeneratingId(null);
    setRunning(false);
    setPending((current) => current && current.map((entry) => entry.status === "running" ? { ...entry, status: "error", error: "Stopped." } : entry));
  }
  function clearAttachment(id: string) {
    setRetainedAttachments((current) => { const next = new Map(current); next.delete(id); return next; });
  }

  async function decideApproval(messageId: string, stepId: string, decision: "approve" | "cancel") {
    const message = messages.find((entry) => entry.id === messageId);
    const proposal = message?.steps.find((step) => step.id === stepId)?.approval;
    if (!chatId || running || !message?.persisted || !proposal || proposal.status !== "pending") throw new Error("Wait until the proposal has been saved, then try again.");
    const targetChat = chatId;
    const attachmentId = proposal.request.operation === "save_attachment" ? proposal.request.attachmentId : null;
    const attachmentData = decision === "approve" && attachmentId ? retainedAttachments.get(attachmentId)?.data : undefined;
    if (decision === "approve" && attachmentId && !attachmentData) throw new Error("Reattach the original file and ask to save it again. Its bytes are no longer in this tab.");
    const result = await approveChatAction({ messageId, stepId, decision, ...(attachmentData ? { attachmentData } : {}) });
    if (!result.success) {
      void client.invalidateQueries({ queryKey: ["drive-chat", targetChat] });
      throw new Error(result.error);
    }
    client.setQueryData<DriveChat>(["drive-chat", targetChat], (current) => current && ({ ...current, messages: current.messages.map((entry) => entry.id !== messageId ? entry : { ...entry, steps: entry.steps.map((step) => step.id === stepId ? { ...step, approval: result.data } : step) }) }));
    if (result.data.status === "completed") {
      if (attachmentId) clearAttachment(attachmentId);
      if (proposal.request.operation === "rename_item") invalidateDriveMetadata(client, [proposal.request.itemId]);
      else void client.invalidateQueries({ queryKey: ["drive"] });
      void client.invalidateQueries({ queryKey: ["storage-usage"] });
    }
    void client.invalidateQueries({ queryKey: ["drive-chat", targetChat] });
  }

  const runtime = useExternalStoreRuntime<ChatEntry>({
    messages, convertMessage, isRunning: running,
    isLoading: Boolean(chatId) && chat.isPending && !pending,
    onNew: async () => {},
    onCancel: async () => stop(),
  });

  const context: ChatMessageContext = {
    byId: new Map(messages.map((entry) => [entry.id, entry])),
    lastAssistantId: messages.findLast((entry) => entry.role === "assistant")?.id ?? null,
    running, open, regeneratingId, searchHitId: search.activeMessageId,
    onOpenItem: (item) => { setOpening(item); onOpenChange(false); },
    onRegenerate: regenerate,
    retainedAttachments,
    savedAttachmentIds: new Set(messages.flatMap((message) => message.steps.flatMap((step) => step.approval?.status === "completed" && step.approval.request.operation === "save_attachment" ? [step.approval.request.attachmentId] : []))),
    onSaveAttachment: (id) => {
      const attachment = retainedAttachments.get(id);
      if (attachment) send({ text: `Please propose saving “${attachment.name}” to My drive, keeping its original contents.`, mentions: [], attachments: [attachment] });
    },
    onClearAttachment: clearAttachment,
    onApproval: decideApproval,
    onFeedback: (messageId, value) => {
      setFeedback((current) => ({ ...current, [messageId]: value }));
      void setChatFeedback({ messageId, feedback: value }).then((result) => {
        if (!result.success) {
          toast.error(result.error);
          setFeedback((current) => { const next = { ...current }; delete next[messageId]; return next; });
        }
      });
    },
  };

  async function confirmDelete() {
    if (!chatId) return;
    const result = await deleteChat(chatId);
    if (!result.success) toast.error(result.error);
    else {
      for (const message of messages) for (const attachment of message.attachments) if (attachment.id) clearAttachment(attachment.id);
      client.removeQueries({ queryKey: ["drive-chat", chatId] });
      switchTo(null);
      await client.invalidateQueries({ queryKey: ["drive-chats"] });
      toast.success("Chat deleted");
    }
    setDeleting(false);
  }

  const empty = messages.length === 0 && !(chatId && chat.isPending);
  const blocked = consent === "pending" || consent === "denied";

  return <Sheet open={open} onOpenChange={onOpenChange} onOpenChangeComplete={(isOpen) => {
    if (isOpen || !opening) return;
    setOpening(null);
    onOpenItem(opening);
  }}>
    <SheetContent side="right" keepMounted showCloseButton={false}
      className={cn("gap-0 data-[side=right]:w-full motion-safe:transition-[max-width,opacity,translate]", wide ? "data-[side=right]:sm:max-w-4xl" : "data-[side=right]:sm:max-w-lg")}
      onKeyDownCapture={(event) => {
        // Find in this conversation instead of the drive's command menu.
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          search.show();
        } else if (event.key === "Escape" && search.open) {
          event.preventDefault();
          event.stopPropagation();
          search.hide();
        }
      }}>
      <SheetDescription className="sr-only">Answers from files you can open, with sources. Chats are private to you.</SheetDescription>
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <PopoverTrigger render={<button type="button" className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring" />}>
            <SheetTitle className="truncate text-sm font-medium">{title}</SheetTitle>
            <ChevronDown className="size-3.5 shrink-0 text-foreground/45" />
          </PopoverTrigger>
          <PopoverContent align="start" className="max-h-[70dvh] w-80 gap-1 overflow-y-auto rounded-2xl p-1.5">
            <ThreadSearch className="max-w-none border-0 bg-transparent p-1.5 dark:bg-transparent" placeholder="Search chats" query={historyQuery} onQueryChange={setHistoryQuery} activeId={chatId ?? ""}
              threads={(chats.data ?? []).map((entry) => ({ id: entry.id, title: entry.title, group: historyGroup(entry.updatedAt), preview: `${relativeAge(entry.updatedAt)}${entry.preview && entry.preview !== entry.title ? ` · ${entry.preview}` : ""}` }))}
              onSelect={(id) => switchTo(id)} />
            <Button variant="outline" className="mx-1.5 mb-1.5 rounded-xl" onClick={() => switchTo(null)}><Plus data-icon="inline-start" />New conversation</Button>
          </PopoverContent>
        </Popover>
        <div className="ms-auto flex items-center gap-0.5">
          <button type="button" aria-label="New conversation" onClick={() => switchTo(null)} className={cn(ghostButton, "size-8")}><Plus className="size-4" /></button>
          {chatId && <DropdownMenu>
            <DropdownMenuTrigger render={<button type="button" aria-label="Chat actions" className={cn(ghostButton, "size-8")} />}><Ellipsis className="size-4" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => setRenaming(title)}><Pencil />Rename</DropdownMenuItem>
                <DropdownMenuItem onClick={() => search.show()}>Find in chat<span className="ms-auto text-xs text-muted-foreground">Ctrl F</span></DropdownMenuItem>
                {retainedAttachments.size > 0 && <DropdownMenuItem onClick={() => setRetainedAttachments(new Map())}>Clear unsaved uploads from memory</DropdownMenuItem>}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}><Trash2 />Delete</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>}
          <button type="button" aria-label={wide ? "Narrow" : "Expand"} onClick={() => setWide(!wide)} className={cn(ghostButton, "hidden size-8 sm:inline-flex")}>
            {wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
          <SheetClose render={<button type="button" aria-label="Close" className={cn(ghostButton, "size-8")} />}><X className="size-4" /></SheetClose>
        </div>
      </header>

      <AssistantRuntimeProvider runtime={runtime}>
        <ChatMessageProvider value={context}>
          {search.open && <div className="border-b border-border/60 px-3 py-2">
            <ConversationSearch className="max-w-none" query={search.query} hits={search.hits} activeIndex={search.active} onQueryChange={search.setQuery} onStep={search.step}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); search.step(event.shiftKey ? -1 : 1); } }} />
          </div>}
          <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4">
              {blocked ? <div className="m-auto flex w-full max-w-sm flex-col items-center gap-3 py-8">
                <PermissionGrant className="max-w-none" capability="Search, read and organize your files" requester="Ask AI" scope={consent === "denied" ? "denied" : "pending"}
                  reach={["File passages and attached images are sent to the configured AI models through OpenRouter", "Password-protected and excluded folders are never included", "Creating, renaming, moving and saving files always requires your approval", "Your chats are private; unsaved upload bytes stay only in this tab"]}
                  onGrant={consent === "pending" ? writeConsent : undefined} />
                {consent === "denied" && <Button variant="ghost" size="sm" onClick={() => writeConsent("pending")}>Review this choice</Button>}
              </div> : empty ? <EmptyState className="m-auto max-w-none py-8">
                <EmptyStateGreeting>What would you like to know?</EmptyStateGreeting>
                <p className="-mt-4 max-w-sm text-center text-sm text-foreground/45">Answers come only from files you can open, with sources. Type @ to search one member&apos;s files.</p>
                <EmptyStateSuggestions>
                  {SUGGESTIONS.map((suggestion, index) => <EmptyStateSuggestion key={suggestion} index={index} onClick={() => send({ text: suggestion, mentions: [], attachments: [] })}>{suggestion}</EmptyStateSuggestion>)}
                </EmptyStateSuggestions>
              </EmptyState> : <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-6">
                <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
                {chat.isError && chatId && <p role="alert" className="text-sm text-destructive">{chat.error.message}</p>}
              </div>}
              <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto bg-popover pb-3">
                <div className="mx-auto w-full max-w-3xl">
                  <ChatComposer key={composerKey} running={running} disabled={blocked} onSubmit={send} onStop={stop}
                    placeholder={blocked ? "Allow Ask AI to read your files first" : "Ask about your files, or @ to mention a member"} />
                  {retainedAttachments.size > 0 && <p className="px-2 pt-2 text-center text-[11px] leading-relaxed text-muted-foreground">Unsaved uploads stay in memory until saved or cleared. After a reload, reattach them to save.</p>}
                </div>
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </ChatMessageProvider>
      </AssistantRuntimeProvider>
    </SheetContent>

    {renaming !== null && <Dialog open onOpenChange={(isOpen) => { if (!isOpen) setRenaming(null); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Rename chat</DialogTitle></DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={async (event) => {
          event.preventDefault();
          if (!chatId) return;
          const result = await renameChat({ id: chatId, title: renaming });
          if (!result.success) toast.error(result.error);
          else { void client.invalidateQueries({ queryKey: ["drive-chats"] }); setRenaming(null); }
        }}>
          <Input autoFocus value={renaming} maxLength={80} onChange={(event) => setRenaming(event.target.value)} aria-label="Chat title" />
          <DialogFooter><Button type="submit" disabled={!renaming.trim()}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>}
    {deleting && <AlertDialog open onOpenChange={(isOpen) => { if (!isOpen) setDeleting(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">Delete “{title}”?</AlertDialogTitle>
          <AlertDialogDescription>The questions, answers and quoted passages in this chat are removed permanently.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={(event) => { event.preventDefault(); void confirmDelete(); }}>Delete chat</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>}
  </Sheet>;
}
