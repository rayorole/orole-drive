"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getThumbnailUrl } from "@/lib/drive-read-client";
import { canThumbnail, getPreviewKind } from "@/lib/file-preview";
import type { DriveItem } from "@/lib/drive-types";
import { Hint } from "@/components/hint";

export function DriveThumbnail({ item, fallback }: { item: DriveItem; fallback: ReactNode }) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const eligible = !item.trashedAt && canThumbnail(item);
  useEffect(() => {
    if (!eligible || !container.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "160px" });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [eligible]);
  const thumbnail = useQuery({
    queryKey: ["drive-thumbnail", item.id],
    queryFn: async ({ signal }) => {
      // Passive grid loading never opens a password prompt; opening the file is the unlock action.
      const result = await getThumbnailUrl(item.id, signal);
      signal.throwIfAborted();
      if (!result.success) throw new Error(result.error);
      return result.data.url;
    },
    enabled: eligible && visible,
    staleTime: 45_000,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const url = eligible ? thumbnail.data : null;
  const unavailable = getPreviewKind(item) === "image" && (!eligible || thumbnail.isError || thumbnail.data === null || failedUrl === url);
  return <Hint label={unavailable ? "Thumbnail unavailable. Open the file to preview or download it." : null}><span ref={container} className="flex size-full min-h-12 items-center justify-center overflow-hidden">
    {url && failedUrl !== url ?
      // Do not route private signed derivatives through a public image optimizer cache.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" width={320} height={240} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="size-full object-contain" onError={() => setFailedUrl(url)} />
      : fallback}
    {unavailable && <span className="sr-only">Thumbnail unavailable</span>}
  </span></Hint>;
}
