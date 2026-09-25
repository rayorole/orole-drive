"use client";

import { useState, useSyncExternalStore } from "react";
import { Check, Copy, Eye, LogOut, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const TOOLS = "list_folder, search_files, get_file_info, read_file, get_download_link, create_folder, write_file, rename_item, move_item, trash_item, share_file, storage_summary";

function setupPrompt(endpoint: string) {
  return `Connect to my Orole Drive over MCP at ${endpoint} (MCP 2026-07-28; stateless HTTP). Authenticate with OAuth authorization code + S256 PKCE using a registered client or an HTTPS Client ID Metadata Document. Use this same endpoint URL as the OAuth resource. Start with mcp:read; you'll sign in and approve access in a browser. Optional offline_access permits refresh only while that sign-in is active. Tools: ${TOOLS}. read_file supports bounded text, small images, and PDF text (up to 5 MiB, 20 pages or 64,000 characters; no OCR). Resources: drive://root, drive://file/<id>, drive://folder/<id>. Prompts: summarize-folder, find-duplicates, cleanup-suggestions. Request mcp:write, mcp:share or mcp:trash only when needed, then ask me to approve the new permissions. Trash and sharing require MCP form elicitation: show me the exact action, collect explicit confirmation, and return the signed requestState unchanged with inputResponses. Never assume confirmation. Signing out of Orole Drive ends this connection's access.`;
}

const SAFEGUARDS = [
  { icon: Eye, text: "Read-only until you approve more" },
  { icon: ShieldCheck, text: "Asks before trashing or sharing" },
  { icon: LogOut, text: "Signing out disconnects it" },
];

// The origin cannot change without a new document; only hydration needs a snapshot.
const subscribeToOrigin = () => () => {};
const browserEndpoint = () => `${window.location.origin}/api/mcp`;
const serverEndpoint = () => "";

export function McpConnectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const endpoint = useSyncExternalStore(subscribeToOrigin, browserEndpoint, serverEndpoint);
  const [copied, setCopied] = useState(false);

  async function copy(text: string, onCopied: () => void) {
    try {
      await navigator.clipboard.writeText(text);
      onCopied();
    } catch {
      toast.error("Could not copy. Select the server URL and copy it manually.");
    }
  }
  const copyUrl = () => copy(endpoint, () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); });
  const copyPrompt = () => copy(setupPrompt(endpoint), () => toast.success("Setup prompt copied"));

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-5 sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Connect an AI assistant</DialogTitle>
        <DialogDescription>Let Claude or another MCP assistant browse and manage your drive.</DialogDescription>
      </DialogHeader>
      <div className="flex gap-2">
        <Input id="mcp-endpoint" aria-label="MCP server URL" value={endpoint} readOnly onFocus={(event) => event.target.select()} className="font-mono text-xs" />
        <Button onClick={copyUrl} className="w-24 shrink-0">{copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}{copied ? "Copied" : "Copy"}</Button>
      </div>
      <ul className="flex flex-col gap-2.5 rounded-xl border border-border/70 bg-muted/30 p-3">
        {SAFEGUARDS.map(({ icon: Icon, text }) => <li key={text} className="flex items-center gap-2.5 text-sm">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />{text}
        </li>)}
      </ul>
      <p className="text-xs text-muted-foreground">Needs an assistant with MCP 2026-07-28 and OAuth sign-in.</p>
      <DialogFooter>
        <Button variant="outline" onClick={copyPrompt}>Copy setup prompt</Button>
        <Button onClick={() => onOpenChange(false)}>Done</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
