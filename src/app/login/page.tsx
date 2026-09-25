import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Cloud, LockKeyhole } from "lucide-react";
import { LoginForm } from "@/components/login-form";
import { ThemeToggle } from "@/components/theme-toggle";
import { getSession } from "@/lib/auth";
import { oauthQueryFromSearchParams } from "@/lib/mcp-auth";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your family’s shared drive.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const oauthQuery = oauthQueryFromSearchParams(await searchParams);
  // An OAuth login prompt may require a fresh session even if cookies exist.
  if (!oauthQuery && await getSession()) redirect("/");

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex w-full items-center justify-between border-b px-4 py-3">
        <Link href="/login" aria-label="Orole Drive home" className="flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4">
          <Cloud className="size-6 text-primary" strokeWidth={1.8} aria-hidden="true" />
          <span className="text-sm font-medium">Orole Drive</span>
        </Link>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-7 px-5 py-12">
        <div className="flex w-full max-w-md flex-col items-start gap-5">
          <div className="flex size-16 items-center justify-center rounded-2xl border border-primary/15 bg-linear-to-br from-primary/10 to-primary/25 text-primary shadow-[inset_0_1px_1px_rgb(255_255_255/.4),0_3px_8px_rgb(0_0_0/.06)]">
            <Cloud className="size-9" strokeWidth={1.4} aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-medium tracking-tight">A place for all our files.</h1>
            <p className="text-sm text-muted-foreground">Photos, documents, and everyday things. Together.</p>
          </div>
        </div>
        <LoginForm oauthQuery={oauthQuery} />
      </main>
      <footer className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-5 py-6 text-center text-xs text-muted-foreground">
        <LockKeyhole className="size-3.5" aria-hidden="true" />
        <p>Private to @orole.be. Public only when you share a link.</p>
      </footer>
    </div>
  );
}
