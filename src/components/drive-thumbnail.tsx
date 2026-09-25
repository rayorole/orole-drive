"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getThumbnailUrl } from "@/app/actions/thumbnails";
import { canThumbnail, getPreviewKind } from "@/lib/file-preview";
import type { DriveItem } from "@/lib/drive-types";

export function DriveThumbnail({ item, fallback }: { item: DriveItem; fallback: ReactNode }) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const eligible = !item.trashedAt && canThumbnail(item);
  const queryClient = useQueryClient();
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
  useEffect(() => {
    const clearAccess = () => { void queryClient.resetQueries({ queryKey: ["drive-thumbnail", item.id], exact: true }); };
    window.addEventListener("drive-access-changed", clearAccess);
    return () => window.removeEventListener("drive-access-changed", clearAccess);
  }, [item.id, queryClient]);
  const thumbnail = useQuery({
    queryKey: ["drive-thumbnail", item.id],
    queryFn: async ({ signal }) => {
      // Passive grid loading never opens a password prompt; opening the file is the unlock action.
      const result = await getThumbnailUrl(item.id);
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
  return <span ref={container} className="flex size-full min-h-12 items-center justify-center overflow-hidden" title={unavailable ? "Thumbnail unavailable. Open the file to preview or download it." : undefined}>
    {url && failedUrl !== url ?
      // Do not route private signed derivatives through a public image optimizer cache.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" width={320} height={240} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="size-full object-contain" onError={() => setFailedUrl(url)} />
      : fallback}
    {unavailable && <span className="sr-only">Thumbnail unavailable</span>}
  </span>;
}
