import Link from "next/link";
import { notFound } from "next/navigation";
import { Cloud } from "lucide-react";
import { getPublicFile } from "@/lib/storage";
import { PublicFile } from "@/components/public-file";
import { ThemeToggle } from "@/components/theme-toggle";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shared file", robots: { index: false, follow: false } };

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const file = await getPublicFile(token);
  if (!file) notFound();
  return <div className="flex min-h-dvh flex-col bg-background">
    <header className="border-b border-border/60">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-8">
        <Link href="/" className="flex items-center gap-2 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"><Cloud className="size-5 text-primary" strokeWidth={1.7} aria-hidden="true" />Orole Drive</Link>
        <ThemeToggle />
      </div>
    </header>
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 pb-16 pt-8 sm:px-8 sm:pt-12">
      <PublicFile item={file.item} token={token} previewUrl={file.previewUrl} sharedByEmail={file.sharedByEmail} />
    </main>
  </div>;
}
