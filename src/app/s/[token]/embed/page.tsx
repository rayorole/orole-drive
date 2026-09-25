import { notFound } from "next/navigation";
import { getPublicShare } from "@/lib/public-share";
import { getPreviewKind } from "@/lib/file-preview";

export const dynamic = "force-dynamic";
export const metadata = { title: "Embedded file", robots: { index: false, follow: false } };

const EMBEDDABLE_KINDS: Record<string, true> = { image: true, video: true, pdf: true };

export default async function SharedFileEmbedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const file = await getPublicShare(token);
  if (file?.kind !== "file") notFound();
  const kind = getPreviewKind(file.item);
  if (!kind || EMBEDDABLE_KINDS[kind] !== true || !file.previewUrl) notFound();
  return <div className="flex h-dvh w-full items-center justify-center bg-black">
    {kind === "image"
      // Signed, short-lived R2 URLs must not be cached by Next's image optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={file.previewUrl} alt={file.item.name} className="max-h-full max-w-full object-contain" />
      : kind === "video"
      ? <video src={file.previewUrl} controls playsInline preload="metadata" className="h-full w-full" aria-label={file.item.name} />
      : <embed src={file.previewUrl} type="application/pdf" className="h-full w-full" title={file.item.name} />}
  </div>;
}
