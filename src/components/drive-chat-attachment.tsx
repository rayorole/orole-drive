"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import type { OutgoingAttachment } from "@/components/drive-chat-composer";
import { Button } from "@/components/ui/button";

function attachmentBytes(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function rasterMime(data: string) {
  const signature = atob(data.slice(0, 32));
  if (signature.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (signature.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) return "image/gif";
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

function OriginalAttachment({ file }: { file: OutgoingAttachment }) {
  const [imageError, setImageError] = useState(false);
  const preview = useMemo(() => {
    const mimeType = rasterMime(file.data);
    if (mimeType) return { image: `data:${mimeType};base64,${file.data}`, text: null, truncated: false };
    if (file.mimeType.startsWith("text/") || /\.(txt|md|csv|json|xml|yaml|yml|log)$/i.test(file.name)) {
      const text = new TextDecoder().decode(attachmentBytes(file.data));
      return { image: null, text: text.slice(0, 24_000), truncated: text.length > 24_000 };
    }
    return { image: null, text: null, truncated: false };
  }, [file]);
  function download() {
    // Download-only, including HTML/SVG: never navigate to untrusted attachment bytes.
    const url = URL.createObjectURL(new Blob([attachmentBytes(file.data)], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return <div className="flex min-w-0 flex-col items-start gap-2 pt-2">
    {preview.image && !imageError && /* eslint-disable-next-line @next/next/no-img-element -- Local original raster bytes, signature checked; never SVG. */
      <img src={preview.image} alt={file.name} className="max-h-64 max-w-full rounded-lg object-contain" onError={() => setImageError(true)} />}
    {preview.text !== null && <pre tabIndex={0} aria-label={`Original contents of ${file.name}`} className="max-h-48 w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-2 text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring">{preview.text || "Empty text"}</pre>}
    {preview.truncated && <p className="text-xs text-muted-foreground">Preview shows the first 24,000 characters. Download the original to review the whole file.</p>}
    {(!preview.image && preview.text === null || imageError) && <p className="text-xs text-muted-foreground">Download the original to review it in an app that supports this file.</p>}
    <Button size="xs" variant="outline" onClick={download}><Download data-icon="inline-start" />Download original</Button>
    <p className="text-xs text-muted-foreground">These are the original bytes; downloading does not save anything to Drive.</p>
  </div>;
}

export function ChatAttachmentPreview({ file }: { file: OutgoingAttachment }) {
  const [open, setOpen] = useState(false);
  return <details className="min-w-0 text-xs" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer rounded py-1.5 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">Review original file</summary>
    {open && <OriginalAttachment file={file} />}
  </details>;
}
