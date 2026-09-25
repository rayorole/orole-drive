"use client";

import dynamic from "next/dynamic";
import type { OfficeKind } from "@/lib/file-preview";
import { Spinner } from "@/components/spinner";

export type OfficePreviewProps = { url: string; name: string; size: number; kind: OfficeKind; onReload: () => void; isReloading?: boolean };

export const OfficePreview = dynamic<OfficePreviewProps>(() => import("@/components/office-document-preview"), {
  ssr: false,
  loading: () => <div role="status" className="flex w-full items-center justify-center gap-2 py-24 text-sm text-muted-foreground"><Spinner />Loading Office preview…</div>,
});
