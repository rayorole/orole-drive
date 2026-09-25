"use client";

import { useEffect, useRef, useState } from "react";
import { onlineManager } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Wifi, WifiLow, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

type Connection = "online" | "unstable" | "offline";

const PING_TIMEOUT_MS = 5_000;
/** A ping slower than this counts as a bad sample even if it succeeds. */
const SLOW_PING_MS = 2_500;
const HEALTHY_INTERVAL_MS = 30_000;
const DEGRADED_INTERVAL_MS = 5_000;

async function ping(): Promise<"ok" | "slow" | "failed"> {
  const started = performance.now();
  try {
    const response = await fetch("/api/ping", { method: "HEAD", cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    // A redirect (e.g. to sign-in) still proves the server is reachable.
    if (!response.ok && response.type !== "opaqueredirect") return "failed";
    return performance.now() - started > SLOW_PING_MS ? "slow" : "ok";
  } catch {
    return "failed";
  }
}

/**
 * Offline when the browser says so or the server stops answering; unstable when pings are slow or
 * intermittently fail. While not online, it re-checks every few seconds so recovery shows up fast.
 */
function useConnection(): Connection {
  const [browserOnline, setBrowserOnline] = useState(true);
  const [reachability, setReachability] = useState<Connection>("online");
  const failures = useRef(0);

  useEffect(() => {
    const update = () => setBrowserOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);

  useEffect(() => {
    if (!browserOnline) return;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    async function check() {
      if (document.visibilityState === "visible") {
        const result = await ping();
        if (cancelled) return;
        failures.current = result === "failed" ? failures.current + 1 : 0;
        // One failed or slow ping is "unstable"; three failures in a row means the server is unreachable.
        const next: Connection = failures.current >= 3 ? "offline" : result === "ok" ? "online" : "unstable";
        setReachability(next);
        timer = setTimeout(check, next === "online" ? HEALTHY_INTERVAL_MS : DEGRADED_INTERVAL_MS);
      } else {
        timer = setTimeout(check, HEALTHY_INTERVAL_MS);
      }
    }
    void check();
    const recheck = () => { clearTimeout(timer); void check(); };
    document.addEventListener("visibilitychange", recheck);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener("visibilitychange", recheck); };
  }, [browserOnline]);

  const connection = browserOnline ? reachability : "offline";
  // React Query pauses queries and mutations while offline and keeps showing cached data, then resumes.
  useEffect(() => { onlineManager.setOnline(connection !== "offline"); }, [connection]);
  return connection;
}

const MESSAGES = {
  offline: { icon: WifiOff, title: "You’re offline", detail: "You can keep browsing what’s loaded. Changes resume when you reconnect." },
  unstable: { icon: WifiLow, title: "Unstable connection", detail: "Some actions may be slow or need a retry." },
  online: { icon: Wifi, title: "Back online", detail: null },
} as const;

/** A small banner at the top of the page; the rest of the UI stays usable underneath. */
export function ConnectionStatus() {
  const connection = useConnection();
  const [showRecovered, setShowRecovered] = useState(false);
  const previous = useRef<Connection>("online");

  useEffect(() => {
    const wasDown = previous.current !== "online";
    previous.current = connection;
    if (connection !== "online" || !wasDown) return;
    setShowRecovered(true);
    const timer = setTimeout(() => setShowRecovered(false), 3_000);
    return () => clearTimeout(timer);
  }, [connection]);

  const visible = connection !== "online" || showRecovered;
  const { icon: Icon, title, detail } = MESSAGES[connection];

  return <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center px-4">
    <AnimatePresence>
      {/* One element for every state: switching offline → unstable → back online updates it in place rather than stacking two banners. */}
      {visible && <motion.div key="connection-banner" role="status"
        initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
        className={cn(
          "pointer-events-auto flex max-w-md items-center gap-2.5 rounded-xl border px-3.5 py-2 text-sm shadow-lg backdrop-blur",
          connection === "offline" && "border-destructive/40 bg-popover/95 text-foreground",
          connection === "unstable" && "border-amber-500/40 bg-popover/95 text-foreground",
          connection === "online" && "border-border bg-popover/95 text-foreground",
        )}>
        <Icon aria-hidden="true" className={cn("size-4 shrink-0",
          connection === "offline" && "text-destructive", connection === "unstable" && "text-amber-500", connection === "online" && "text-emerald-500")} />
        <p className="min-w-0"><span className="font-medium">{title}</span>{detail && <span className="text-muted-foreground"> · {detail}</span>}</p>
      </motion.div>}
    </AnimatePresence>
  </div>;
}
