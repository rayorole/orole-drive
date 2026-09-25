"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ShareQr({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    setError(false);
    QRCode.toCanvas(canvas, url, { width: 152, margin: 1, errorCorrectionLevel: "M" }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => { cancelled = true; };
  }, [url]);

  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = "orole-drive-share-qr.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  return <div className="flex items-center gap-4 rounded-xl border border-border/70 p-3">
    <div className="flex size-[136px] shrink-0 items-center justify-center rounded-lg bg-white p-1.5">
      {error
        ? <p className="px-2 text-center text-xs text-neutral-500">QR code couldn’t render.</p>
        : <canvas ref={canvasRef} width={152} height={152} className="size-full" role="img" aria-label="QR code for the public share link" />}
    </div>
    <div className="flex min-w-0 flex-col items-start gap-2">
      <p className="text-xs text-muted-foreground">Scan to open the link on a phone.</p>
      <Button type="button" variant="outline" size="sm" disabled={error} onClick={download}>
        <Download data-icon="inline-start" />Download PNG
      </Button>
    </div>
  </div>;
}
