"use client";

import { Button } from "@/components/ui/button";
import { CloudAlert } from "lucide-react";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="flex min-h-dvh flex-col items-center justify-center gap-5 p-6 text-center">
    <CloudAlert className="size-10 text-muted-foreground" aria-hidden="true" />
    <h1 className="text-2xl font-semibold tracking-tight">The drive couldn’t be opened</h1>
    <p className="max-w-md text-muted-foreground">The connection may have been interrupted. Try again in a moment.</p>
    <Button onClick={reset}>Try again</Button>
  </main>;
}
