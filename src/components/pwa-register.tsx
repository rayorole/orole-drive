"use client";

import { useEffect } from "react";

export function PwaRegister() {
  useEffect(() => {
    if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker
      .register("/pwa-sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => undefined);
  }, []);

  return null;
}
