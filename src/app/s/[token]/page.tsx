import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Cloud } from "lucide-react";
import { getPublicFolderFile, getPublicFolderView, getPublicShare } from "@/lib/public-share";
import { PublicFile } from "@/components/public-file";
import { PublicFolder, PublicShareBreadcrumbs } from "@/components/public-folder";
import { ThemeToggle } from "@/components/theme-toggle";

export const dynamic = "force-dynamic";

type SharePageProps = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Pick<SharePageProps, "params">): Promise<Metadata> {
  const share = await getPublicShare((await params).token);
  return { title: share?.kind === "folder" ? "Shared folder" : "Shared file", robots: { index: false, follow: false } };
}

async function ShareContent({ token, folderId, fileId }: { token: string; folderId: string | null; fileId: string | null }) {
  const share = await getPublicShare(token);
  if (!share) notFound();
  if (share.kind === "file") return <PublicFile item={share.item} token={token} previewUrl={share.previewUrl} sharedByEmail={share.sharedByEmail} />;
  if (fileId) {
    const file = await getPublicFolderFile(token, fileId);
    if (!file) notFound();
    return <div className="flex flex-col gap-6">
      <PublicShareBreadcrumbs token={token} crumbs={file.breadcrumbs} current={file.item.name} />
      <PublicFile item={file.item} token={token} inFolder previewUrl={file.previewUrl} sharedByEmail={file.sharedByEmail} />
    </div>;
  }
  const view = await getPublicFolderView(token, folderId);
  if (!view) notFound();
  return <PublicFolder token={token} view={view} />;
}

export default async function SharePage({ params, searchParams }: SharePageProps) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  return <div className="flex min-h-dvh flex-col bg-background">
    <header className="border-b border-border/60">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-8">
        <Link href="/" className="flex items-center gap-2 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"><Cloud className="size-5 text-primary" strokeWidth={1.7} aria-hidden="true" />Orole Drive</Link>
        <ThemeToggle />
      </div>
    </header>
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 pb-16 pt-8 sm:px-8 sm:pt-12">
      <ShareContent token={token} folderId={typeof query.folder === "string" ? query.folder : null} fileId={typeof query.file === "string" ? query.file : null} />
    </main>
  </div>;
}
