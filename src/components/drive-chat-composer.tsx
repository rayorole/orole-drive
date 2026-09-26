"use client";

import { useMemo, useRef, useState } from "react";
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
import { profileAvatarUrl } from "@/lib/profile-avatar";

/** Keep in step with CHAT_ATTACHMENT_MAX_BYTES on the server (Vercel's request body limit). */
const MAX_ATTACHMENT_BYTES = 3 * 1_048_576;
const MAX_ATTACHMENTS = 3;

export type OutgoingAttachment = { id: string; name: string; mimeType: string; data: string; size: number; kind: "image" | "text" | "archive" };
export type ComposerSubmission = { text: string; mentions: { id: string; name: string }[]; attachments: OutgoingAttachment[] };

type Staged = ComposerAttachment & { id: string; size: number; file?: OutgoingAttachment };

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
  const stagedRef = useRef<Staged[]>([]);
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
  const people = useMemo(() => (members.data ?? []).map((member) => ({ id: member.id, name: member.name || member.email, avatarUrl: profileAvatarUrl(member), role: "human" as const })), [members.data]);
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

  function updateStaged(change: (current: Staged[]) => Staged[]) {
    stagedRef.current = change(stagedRef.current);
    setStaged(stagedRef.current);
  }

  async function addFiles(files: FileList | null) {
    for (const file of Array.from(files ?? [])) {
      const id = crypto.randomUUID();
      const used = stagedRef.current.reduce((sum, entry) => sum + (entry.state === "error" ? 0 : entry.size), 0);
      const kind = /^image\/(jpeg|png|gif|webp)$/i.test(file.type) ? "image" as const : file.type.startsWith("text/") || /\.(txt|md|csv|json|pdf|docx|xlsx|pptx)$/i.test(file.name) ? "text" as const : "archive" as const;
      const meta = `${Math.max(1, Math.round(file.size / 1024))} KB`;
      if (stagedRef.current.filter((entry) => entry.state !== "error").length >= MAX_ATTACHMENTS || used + file.size > MAX_ATTACHMENT_BYTES) {
        updateStaged((current) => [...current, { id, size: file.size, name: file.name, meta: "Up to 3 files, 3 MB total", state: "error", kind }]);
        continue;
      }
      updateStaged((current) => [...current, { id, size: file.size, name: file.name, meta, state: "uploading", progress: 40, kind }]);
      try {
        const data = await readBase64(file);
        updateStaged((current) => current.map((entry) => entry.id === id
          ? { ...entry, state: "done", progress: 100, file: { id, name: file.name, mimeType: file.type || "application/octet-stream", data, size: file.size, kind } } : entry));
      } catch {
        updateStaged((current) => current.map((entry) => entry.id === id ? { ...entry, state: "error", meta: "Could not read file" } : entry));
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
    updateStaged(() => []);
    setPicked([]);
  }

  const servers: McpServer[] = [
    { id: "drive", name: "Orole Drive", transport: "built in · your access", status: "connected", tools: ["list_drive_items", "find_drive_items", "search_drive", "recent_uploads", "drive_activity", "show_drive_tree", "read_file_excerpt", "read_document", "read_spreadsheet", "calculate_spreadsheet", "view_image", "read_image", "compare_versions", "present_comparison"] },
    { id: "actions", name: "Drive actions", transport: "review first · approval required", status: "connected", tools: ["create_file", "create_folder", "rename_item", "move_items", "save_attachment"] },
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
        {staged.map((file) => <ComposerAttachmentChip key={file.id} attachment={file}
          onRemove={() => updateStaged((current) => current.filter((entry) => entry.id !== file.id))} />)}
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
          <input ref={fileInput} type="file" multiple hidden onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
        </ComposerActions>
        <ComposerActions>
          <Popover>
            <PopoverTrigger render={<button type="button" aria-label="What Ask AI can use" className={cn(ghostButton, "size-8")} />}>
              <SlidersHorizontal className="size-4" />
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="max-h-[70dvh] w-80 overflow-y-auto rounded-2xl p-0">
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
