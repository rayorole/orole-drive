import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { DriveWorkspace } from "@/components/drive-workspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  if (!session) redirect("/login");
  return <DriveWorkspace user={{ name: session.user.name, email: session.user.email }} />;
}
