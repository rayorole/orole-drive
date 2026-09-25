"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, TriangleAlert } from "lucide-react";
import { readTextPreview } from "@/lib/file-preview";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";

export function TextPreview({ url, name, size, onReload, isReloading = false }: {
  url: string;
  name: string;
  size: number;
  onReload: () => void;
  isReloading?: boolean;
}) {
  const preview = useQuery({
    queryKey: ["text-preview", url, size],
    queryFn: ({ signal }) => size === 0 ? { text: "", truncated: false, encoding: "UTF-8" } : readTextPreview(url, signal),
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (preview.isPending) return <div role="status" className="flex items-center gap-2 py-24 text-sm text-muted-foreground"><Spinner />Loading text preview…</div>;
  if (preview.error) return <Alert variant="destructive" className="m-4"><TriangleAlert /><AlertTitle>Text preview unavailable</AlertTitle><AlertDescription>{preview.error.message}<Button variant="outline" size="sm" disabled={isReloading} onClick={onReload}>{isReloading && <Spinner />}Reload preview</Button></AlertDescription></Alert>;
  const { text, truncated, encoding } = preview.data;
  return <div className="flex min-w-0 w-full flex-col gap-3 p-4">
    {truncated && <Alert><FileText /><AlertTitle>Showing the first 512 KiB</AlertTitle><AlertDescription>This preview is truncated. Download the file to read the complete text.</AlertDescription></Alert>}
    {text ? <pre tabIndex={0} role="region" aria-label={`Text preview of ${name}`} className="max-h-[55dvh] overflow-auto rounded-lg bg-background p-4 text-left font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"><code>{text}</code></pre>
      : <p className="py-12 text-center text-sm text-muted-foreground">This file is empty.</p>}
    <p className="text-xs text-muted-foreground">{encoding} · Plain-text preview. HTML, SVG, and code are not executed.</p>
  </div>;
}
