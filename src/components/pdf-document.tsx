"use client";

import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
const options = { cMapUrl: "/pdf-assets/cmaps/", standardFontDataUrl: "/pdf-assets/standard_fonts/", wasmUrl: "/pdf-assets/wasm/", isEvalSupported: false };

export default function PdfDocument({ url, name, onError }: { url: string; name: string; onError: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(280);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.min(900, Math.floor(entry.contentRect.width))));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={container} className="flex w-full min-w-0 flex-col gap-3" role="region" aria-label={`PDF preview: ${name}`}>
    <div className="max-h-[60dvh] overflow-auto rounded-lg">
      <Document file={url} options={options} suspense={false} onLoadSuccess={({ numPages }) => { setPages(numPages); setPage((current) => Math.min(current, numPages)); }} onLoadError={onError} onSourceError={onError} onPassword={onError} loading={<div className="flex items-center justify-center gap-2 p-10"><Spinner />Loading PDF…</div>} error={<p className="p-5">The PDF could not be opened. Download it to view it on your device.</p>}>
        <Page pageNumber={page} width={Math.max(100, width)} renderAnnotationLayer={false} renderTextLayer onRenderError={onError} loading={<Spinner label="Rendering page" />} />
      </Document>
    </div>
    {pages > 0 && <div className="flex items-center justify-center gap-3 py-2">
      <Button variant="outline" size="icon" aria-label="Previous PDF page" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft /></Button>
      <p className="text-xs tabular-nums" aria-live="polite">Page {page} of {pages}</p>
      <Button variant="outline" size="icon" aria-label="Next PDF page" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight /></Button>
    </div>}
  </div>;
}
