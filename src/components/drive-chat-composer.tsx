"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { getAssistantStatus, listShareMembers } from "@/lib/drive-read-client";
import {
  applyMention, Composer, ComposerActions, ComposerAttachButton, ComposerAttachmentChip, ComposerAttachments, ComposerBar,
  ComposerInput, ComposerMenu, ComposerPersonItem, ComposerSend, ComposerToolbar, useMentionMatches, type ComposerAttachment,
} from "@/components/assistant-ui/elements/composer";
import { McpServerPanel, type McpServer } from "@/components/assistant-ui/elements/mcp-server-panel";
import { ghostButton } from "@/components/assistant-ui/elements/surfaces";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** Keep in step with CHAT_ATTACHMENT_MAX_BYTES on the server (Vercel's request body limit). */
const MAX_ATTACHMENT_BYTES = 3 * 1_048_576;
const MAX_ATTACHMENTS = 3;
const ACCEPT = ".txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx,image/jpeg,image/png,image/gif,image/webp,text/*";

export type OutgoingAttachment = { name: string; mimeType: string; data: string; size: number; kind: "image" | "text" | "archive" };
export type ComposerSubmission = { text: string; mentions: { id: string; name: string }[]; attachments: OutgoingAttachment[] };

type Staged = ComposerAttachment & { file?: OutgoingAttachment };

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Ask AI's input: attachments, @mentions of drive members, the assistant's server panel and send/stop. */
export function ChatComposer({ running, disabled, placeholder, onSubmit, onStop }: {
  running: boolean;
  disabled: boolean;
  placeholder: string;
  onSubmit: (submission: ComposerSubmission) => boolean;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const [staged, setStaged] = useState<Staged[]>([]);
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  const [activeMention, setActiveMention] = useState(0);
  const [expanded, setExpanded] = useState<string | undefined>("drive");
  const fileInput = useRef<HTMLInputElement>(null);
  const members = useQuery({
    queryKey: ["drive-share-members"],
    queryFn: async ({ signal }) => {
      const result = await listShareMembers(signal);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    staleTime: 60_000,
  });
  const status = useQuery({
    queryKey: ["drive-assistant-status"],
    queryFn: async ({ signal }) => {
      const result = await getAssistantStatus(signal);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    staleTime: 5 * 60_000,
  });
  const people = (members.data ?? []).map((member) => ({ id: member.id, name: member.name || member.email, role: "human" as const }));
  const matches = useMentionMatches(value, people).slice(0, 6);
  const mentionOpen = matches.length > 0 && !disabled;
  const uploading = staged.some((file) => file.state === "uploading");
  const idle = !value.trim() && !staged.some((file) => file.state === "done");

  function pickMention(index: number) {
    const person = matches[index];
    if (!person) return;
    const member = people.find((candidate) => candidate.name === person.name)!;
    setValue(applyMention(value, person.name));
    setPicked((current) => current.some((entry) => entry.id === member.id) ? current : [...current, { id: member.id, name: person.name }]);
    setActiveMention(0);
  }

  async function addFiles(files: FileList | null) {
    for (const file of Array.from(files ?? [])) {
      const used = staged.reduce((sum, entry) => sum + (entry.file?.size ?? 0), 0);
      const kind = file.type.startsWith("image/") ? "image" as const : "text" as const;
      const meta = `${Math.max(1, Math.round(file.size / 1024))} KB`;
      if (staged.length >= MAX_ATTACHMENTS || used + file.size > MAX_ATTACHMENT_BYTES) {
        setStaged((current) => [...current, { name: file.name, meta: "Over the 3 MB limit", state: "error", kind }]);
        continue;
      }
      setStaged((current) => [...current, { name: file.name, meta, state: "uploading", progress: 40, kind }]);
      try {
        const data = await readBase64(file);
        setStaged((current) => current.map((entry) => entry.name === file.name && entry.state === "uploading"
          ? { ...entry, state: "done", progress: 100, file: { name: file.name, mimeType: file.type || "application/octet-stream", data, size: file.size, kind } } : entry));
      } catch {
        setStaged((current) => current.map((entry) => entry.name === file.name && entry.state === "uploading" ? { ...entry, state: "error", meta: "Could not read" } : entry));
      }
    }
  }

  function submit() {
    if (running || disabled || uploading || idle) return;
    const text = value.trim();
    const mentions = picked.filter((member) => text.includes(`@${member.name}`));
    const attachments = staged.flatMap((entry) => entry.file ? [entry.file] : []);
    if (!onSubmit({ text, mentions, attachments })) return;
    setValue("");
    setStaged([]);
    setPicked([]);
  }

  const servers: McpServer[] = [
    { id: "drive", name: "Orole Drive", transport: "built in · your access", status: "connected", tools: ["search_drive", "read_file_excerpt", "compare_versions", "present_comparison"] },
    { id: "index", name: "Semantic index", transport: "Cloudflare Workers AI + Vectorize", status: status.data ? (status.data.semanticIndex ? "connected" : "failed") : "connecting", tools: ["bge-m3 embeddings", "vector search", "keyword search"] },
    { id: "model", name: "Language model", transport: "OpenRouter", status: status.data ? (status.data.model ? "connected" : "failed") : "connecting", tools: status.data?.model ? [status.data.model] : [] },
  ];

  return <Composer className="max-w-none">
    <ComposerMenu open={mentionOpen} role="listbox" aria-label="Mention a member">
      {matches.map((person, index) => <ComposerPersonItem key={person.name} person={person} active={index === activeMention}
        onMouseDown={(event) => { event.preventDefault(); pickMention(index); }} />)}
    </ComposerMenu>
    <ComposerBar dragActive={false}
      onDragOver={(event) => { if (!disabled) event.preventDefault(); }}
      onDrop={(event) => { if (disabled) return; event.preventDefault(); void addFiles(event.dataTransfer.files); }}>
      {staged.length > 0 && <ComposerAttachments className="px-1 pt-1">
        {staged.map((file) => <ComposerAttachmentChip key={file.name} attachment={file}
          onRemove={(name) => setStaged((current) => current.filter((entry) => entry.name !== name))} />)}
      </ComposerAttachments>}
      <ComposerInput value={value} disabled={disabled} placeholder={placeholder} aria-label="Ask a question about your files"
        onChange={(event) => { setValue(event.target.value); setActiveMention(0); }}
        onKeyDown={(event) => {
          if (!mentionOpen) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActiveMention((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
          } else if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            pickMention(activeMention);
          }
        }}
        onSubmit={submit} />
      <ComposerToolbar>
        <ComposerActions>
          <ComposerAttachButton aria-label="Attach files" onClick={disabled ? undefined : () => fileInput.current?.click()} />
          <input ref={fileInput} type="file" multiple hidden accept={ACCEPT} onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
        </ComposerActions>
        <ComposerActions>
          <Popover>
            <PopoverTrigger render={<button type="button" aria-label="What Ask AI can use" className={cn(ghostButton, "size-8")} />}>
              <SlidersHorizontal className="size-4" />
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="w-80 rounded-2xl p-0">
              <McpServerPanel servers={servers} expandedId={expanded} onToggle={(id) => setExpanded((current) => current === id ? undefined : id)} className="max-w-none border-0 bg-transparent dark:bg-transparent" />
            </PopoverContent>
          </Popover>
          <ComposerSend streaming={running} idle={idle || uploading} disabled={!running && (idle || uploading || disabled)}
            onClick={() => (running ? onStop() : submit())} />
        </ComposerActions>
      </ComposerToolbar>
    </ComposerBar>
  </Composer>;
}
