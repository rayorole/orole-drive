"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, TriangleAlert } from "lucide-react";
import { fetchOfficeBytes, OFFICE_LIMITS, OfficePreviewError } from "@/lib/office-archive";
import { loadOfficeDocument } from "@/lib/office-document";
import type { OfficeDocument, OfficeSheet } from "@/lib/office-document";
import type { OfficePreviewProps } from "@/components/office-preview";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/spinner";

const NOTES = {
  docx: "Reading view, not a page-perfect layout. Paragraphs, headings, lists, tables and PNG/JPEG/GIF images are supported. Fonts, page breaks, headers, drawings and advanced formatting may differ or be omitted.",
  xlsx: "Saved cell values only; formulas never run. Up to 40 visible sheets, the first 200 rows and 50 columns per sheet. Hidden sheets, charts, images, merged layouts and cell styling are omitted; dates and other formatted numbers appear as stored values.",
  pptx: "Approximate slide layout with positioned text, basic shapes and PNG/JPEG/GIF images. Fonts, theme effects, grouped rotations, crops, charts, tables, SmartArt, video, transitions and animations may differ or be omitted. Up to 100 slides.",
} as const;

function Sheet({ sheet }: { sheet: OfficeSheet }) {
  const headers = Array.from({ length: sheet.columns }, (_, index) => index < 26 ? String.fromCharCode(65 + index) : `A${String.fromCharCode(65 + index - 26)}`);
  return <>
    {sheet.clipped && <p className="px-4 py-2 text-xs text-muted-foreground">Some cells are outside this preview. Showing rows 1–200 and columns A–AX; download for the full sheet.</p>}
    <div role="region" aria-label={`${sheet.name} cells`} tabIndex={0} className="max-h-[55dvh] overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      {sheet.rows.length ? <table className="w-full border-collapse text-left text-sm tabular-nums">
        <caption className="sr-only">Saved values in {sheet.name}</caption>
        <thead className="sticky top-0 bg-muted"><tr><th scope="col" className="border border-border px-3 py-2"><span className="sr-only">Row</span></th>{headers.map((label) => <th key={label} scope="col" className="min-w-28 border border-border px-3 py-2 font-medium">{label}</th>)}</tr></thead>
        <tbody>{sheet.rows.map((row, index) => <tr key={index}><th scope="row" className="border border-border bg-muted px-3 py-2 font-normal text-muted-foreground">{index + 1}</th>{headers.map((label, column) => <td key={label} className="max-w-80 min-w-28 border border-border bg-background px-3 py-2 align-top whitespace-pre-wrap wrap-anywhere">{row[column] ?? ""}</td>)}</tr>)}</tbody>
      </table> : <p className="py-16 text-center text-sm text-muted-foreground">This sheet has no saved cell values in the previewed range.</p>}
    </div>
  </>;
}

function Slides({ document }: { document: Extract<OfficeDocument, { kind: "pptx" }> }) {
  const [index, setIndex] = useState(0);
  const slide = document.slides[index];
  return <div className="flex flex-col gap-3 p-3 sm:p-4">
    <div className="flex items-center justify-between gap-3">
      <p aria-live="polite" className="text-sm tabular-nums">Slide {index + 1} of {document.slides.length}</p>
      <div className="flex gap-1"><Button variant="outline" size="icon-sm" aria-label="Previous slide" disabled={index === 0} onClick={() => setIndex(index - 1)}><ChevronLeft /></Button><Button variant="outline" size="icon-sm" aria-label="Next slide" disabled={index === document.slides.length - 1} onClick={() => setIndex(index + 1)}><ChevronRight /></Button></div>
    </div>
    <div tabIndex={0} role="region" aria-label={`Slide ${index + 1}`} onKeyDown={(event) => {
      if (event.key === "ArrowRight") { event.preventDefault(); setIndex((value) => Math.min(document.slides.length - 1, value + 1)); }
      if (event.key === "ArrowLeft") { event.preventDefault(); setIndex((value) => Math.max(0, value - 1)); }
    }} className="relative w-full overflow-hidden border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{ aspectRatio: `${document.width} / ${document.height}`, background: slide.background, containerType: "inline-size" }}>
      {slide.shapes.map((shape, shapeIndex) => <div key={shapeIndex} style={{ position: "absolute", left: `${shape.x / document.width * 100}%`, top: `${shape.y / document.height * 100}%`, width: `${shape.width / document.width * 100}%`, height: `${shape.height / document.height * 100}%`, transform: `rotate(${shape.rotation}deg)`, background: shape.fill, border: shape.stroke === "transparent" ? undefined : `1px solid ${shape.stroke}`, borderRadius: shape.ellipse ? "50%" : undefined, overflow: "hidden" }}>
        {shape.image && /* Embedded, validated raster blobs only; no external image URLs. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shape.image} alt={shape.alt ?? "Embedded slide image"} className="size-full object-fill" />}
        {shape.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex} style={{ textAlign: paragraph.align, lineHeight: 1.2, padding: "0.2em 0.35em", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{paragraph.bullet && <span aria-hidden="true">• </span>}{paragraph.runs.map((run, runIndex) => <span key={runIndex} style={{ fontFamily: "Arial, sans-serif", fontSize: `${run.size * 12700 / document.width * 100}cqw`, fontWeight: run.bold ? 700 : 400, fontStyle: run.italic ? "italic" : "normal", color: run.color }}>{run.text}</span>)}</p>)}
      </div>)}
    </div>
  </div>;
}

export default function OfficeDocumentPreview({ url, name, size, kind, onReload, isReloading = false }: OfficePreviewProps) {
  const [state, setState] = useState<{ document?: OfficeDocument; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    const urls = new Set<string>();
    const release = () => { for (const objectUrl of urls) URL.revokeObjectURL(objectUrl); urls.clear(); };
    async function load() {
      try {
        if (size > OFFICE_LIMITS.download) throw new OfficePreviewError("Office previews support files up to 20 MB. Download this file to open it on your device.");
        const bytes = await fetchOfficeBytes(url, controller.signal);
        const document = await loadOfficeDocument(bytes, kind, controller.signal, urls);
        controller.signal.throwIfAborted();
        setState({ document });
      } catch (error) {
        release();
        if (!controller.signal.aborted) setState({ error: error instanceof OfficePreviewError ? error.message : "This document could not be previewed. It may be corrupt, encrypted, or use unsupported features. Download it to open it in Office." });
      }
    }
    void load();
    return () => { controller.abort(); release(); };
  }, [url, size, kind]);
  const document = state.document;
  return <section aria-label={`Office preview of ${name}`} className="w-full min-w-0 self-stretch text-left">
    <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2">
      <p className="text-xs font-medium">{kind === "docx" ? "Word" : kind === "xlsx" ? "Excel" : "PowerPoint"} preview</p>
      <Button variant="ghost" size="sm" onClick={onReload} disabled={isReloading}>{isReloading ? <Spinner /> : <RefreshCw data-icon="inline-start" />}Reload preview</Button>
    </div>
    {state.error ? <Alert variant="destructive" className="m-4 w-auto"><TriangleAlert /><AlertTitle>Office preview unavailable</AlertTitle><AlertDescription>{state.error}</AlertDescription></Alert>
      : !document ? <div role="status" className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground"><Spinner />Reading document locally…</div>
      : document.kind === "docx" ? <div role="region" aria-label="Document contents" tabIndex={0} className="max-h-[60dvh] overflow-auto bg-background px-5 py-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-8"><div className="mx-auto max-w-[72ch] text-sm leading-relaxed [&_p]:my-3 [&_h1]:my-5 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:my-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:my-3 [&_h3]:text-lg [&_h3]:font-semibold [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-3 [&_th]:border [&_th]:border-border [&_th]:px-3 [&_img]:my-4 [&_img]:max-h-96 [&_img]:max-w-full [&_img]:object-contain [&_pre]:whitespace-pre-wrap [&_blockquote]:pl-5" dangerouslySetInnerHTML={{ __html: document.html }} /></div>
      : document.kind === "xlsx" ? <Tabs defaultValue={0} className="gap-0"><div className="overflow-x-auto border-b border-border/70 px-3 py-2"><TabsList aria-label="Worksheets" variant="line">{document.sheets.map((sheet, index) => <TabsTrigger key={index} value={index}>{sheet.name}</TabsTrigger>)}</TabsList></div>{document.sheets.map((sheet, index) => <TabsContent key={index} value={index}><Sheet sheet={sheet} /></TabsContent>)}</Tabs>
      : <Slides document={document} />}
    <div className="flex flex-col gap-1 border-t border-border/70 px-4 py-3 text-xs leading-relaxed text-muted-foreground"><p>{NOTES[kind]}</p><p>Processed in your browser, never sent to an online viewer. External links, remote images, scripts and macros are disabled. Unsupported or oversized images are omitted. Download for the original.</p></div>
  </section>;
}
