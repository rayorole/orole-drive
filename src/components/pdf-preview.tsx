"use client";

import dynamic from "next/dynamic";
import { Spinner } from "@/components/spinner";

const PdfDocument = dynamic(() => import("@/components/pdf-document"), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center gap-2 p-10"><Spinner />Loading PDF…</div>,
});

export function PdfPreview({ url, name, onError }: { url: string; name: string; onError: () => void }) {
  return <PdfDocument url={url} name={name} onError={onError} />;
}
