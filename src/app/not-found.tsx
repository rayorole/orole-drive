import Link from "next/link";
import { CloudOff } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return <main className="flex min-h-dvh flex-col items-center justify-center gap-5 p-6 text-center">
    <CloudOff className="size-10 text-muted-foreground" aria-hidden="true" />
    <h1 className="text-2xl font-semibold tracking-tight">This link is no longer available</h1>
    <p className="max-w-md text-muted-foreground">It may have been removed or made private. Ask the person who shared it for a new link.</p>
    <Link className={buttonVariants({ variant: "outline" })} href="/">Go to Orole Drive</Link>
  </main>;
}
