import Link from "next/link";
import { notFound } from "next/navigation";
import { Cloud, Link2 } from "lucide-react";
import { getPublicFile } from "@/lib/storage";
import { PublicFile } from "@/components/public-file";
import { ThemeToggle } from "@/components/theme-toggle";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shared file", robots: { index: false, follow: false } };

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const file = await getPublicFile(token);
  if (!file) notFound();
  const bytes = file.item.size;
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return <main className="min-h-dvh bg-background">
    <header className="mx-auto flex max-w-5xl items-center justify-between px-5 py-6 sm:px-10">
      <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight"><Cloud className="size-7 text-primary" aria-hidden="true" />Orole Drive</Link>
      <ThemeToggle />
    </header>
    <section className="mx-auto flex max-w-4xl flex-col items-center gap-7 px-5 pb-12 pt-8 sm:px-10 sm:pt-14">
      <div className="flex max-w-full flex-col items-center gap-3 text-center">
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Link2 className="size-4" aria-hidden="true" />Shared with you</p>
        <h1 className="max-w-full wrap-anywhere text-2xl font-semibold tracking-tight sm:text-3xl">{file.item.name}</h1>
        <p className="text-sm text-muted-foreground">{size}</p>
      </div>
      <PublicFile item={file.item} token={token} previewUrl={file.previewUrl} />
    </section>
  </main>;
}
