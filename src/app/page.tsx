import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isChatConfigured, isSearchConfigured } from "@/lib/search-config";
import { DriveWorkspace } from "@/components/drive-workspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  if (!session) redirect("/login");
  const search = isSearchConfigured();
  return <DriveWorkspace user={{ name: session.user.name, email: session.user.email }} search={{ search, chat: search && isChatConfigured() }} />;
}
