"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, TextWrap, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { readTextPreview } from "@/lib/file-preview";
import { HIGHLIGHT_MAX_CHARACTERS, HIGHLIGHT_MAX_LINES, highlightCode, languageFor } from "@/lib/syntax-highlight";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Spinner } from "@/components/spinner";

export function TextPreview({ url, name, size, onReload, isReloading = false, className }: {
  url: string;
  name: string;
  size: number;
  onReload: () => void;
  isReloading?: boolean;
  className?: string;
}) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const language = languageFor(name);
  const preview = useQuery({
    queryKey: ["text-preview", url, size],
    queryFn: ({ signal }) => size === 0 ? { text: "", truncated: false, encoding: "UTF-8" } : readTextPreview(url, signal),
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const text = preview.data?.text ?? "";
  const lines = useMemo(() => text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"), [text]);
  const highlightable = language !== null && text.length > 0 && text.length <= HIGHLIGHT_MAX_CHARACTERS && lines.length <= HIGHLIGHT_MAX_LINES;
  const highlighted = useQuery({
    queryKey: ["text-highlight", url, size, language?.id],
    queryFn: () => highlightCode(lines.join("\n"), language!.id),
    enabled: preview.isSuccess && highlightable,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (preview.isPending) return <div role="status" className="flex w-full items-center justify-center gap-2 py-24 text-sm text-muted-foreground"><Spinner />Loading preview…</div>;
  if (preview.error) return <Alert variant="destructive" className="m-4 max-w-lg"><TriangleAlert /><AlertTitle>Text preview unavailable</AlertTitle><AlertDescription>{preview.error.message}<Button variant="outline" size="sm" disabled={isReloading} onClick={onReload}>{isReloading && <Spinner />}Reload preview</Button></AlertDescription></Alert>;
  const { truncated, encoding } = preview.data;
  const rows = highlighted.data;

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy the text. Select it in the preview and copy it manually.");
    }
  }

  return <div className={cn("flex w-full min-w-0 flex-col self-stretch text-left", className)}>
    <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-1.5 sm:px-4">
      <span className="text-xs font-medium">{language?.name ?? "Plain text"}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{lines.length.toLocaleString()} {lines.length === 1 ? "line" : "lines"}</span>
      <span className="text-xs text-muted-foreground">{encoding}</span>
      {highlighted.isFetching && <Spinner size={12} label="Applying syntax colors" />}
      <div className="ml-auto flex items-center gap-1">
        <Toggle size="sm" pressed={wrap} onPressedChange={setWrap} aria-label="Wrap long lines" title="Wrap long lines"><TextWrap /></Toggle>
        <Button variant="ghost" size="icon-sm" onClick={copyText} disabled={!text} aria-label={copied ? "Copied" : "Copy text"} title={truncated ? "Copy the previewed text" : "Copy text"}>{copied ? <Check /> : <Copy />}</Button>
      </div>
    </div>
    {truncated && <p className="border-b border-border/70 bg-muted/60 px-4 py-2 text-xs text-muted-foreground">Showing the first 512 KiB. Download the file to read the rest.</p>}
    {language && !highlightable && text && <p className="border-b border-border/70 px-4 py-2 text-xs text-muted-foreground">Syntax colors are off for files this large, so the preview stays responsive.</p>}
    {text ? <pre tabIndex={0} role="region" aria-label={`Contents of ${name}`} style={{ "--gutter": `${String(lines.length).length + 1.5}ch` } as CSSProperties} className={cn("code-preview max-h-[70dvh] min-h-40 overflow-auto py-3 font-mono text-[12.5px] leading-[1.6] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", wrap ? "whitespace-pre-wrap wrap-anywhere" : "whitespace-pre")}>
      <code>{(rows ?? lines).map((line, index) => <span key={index} className="code-line">
        {typeof line === "string" ? line : line.map((token, tokenIndex) => <span key={tokenIndex} className="code-token" style={token.style}>{token.content}</span>)}
      </span>)}</code>
    </pre> : <p className="py-16 text-center text-sm text-muted-foreground">This file is empty.</p>}
    <p className="border-t border-border/70 px-4 py-2 text-[11px] text-muted-foreground">Shown as text. HTML, SVG and scripts never run in this preview.</p>
  </div>;
}
