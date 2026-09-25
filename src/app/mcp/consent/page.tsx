import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Cloud, ShieldCheck } from "lucide-react";
import { ConsentActions } from "@/app/mcp/consent/consent-actions";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getAuth, getSession } from "@/lib/auth";
import { oauthQueryFromSearchParams } from "@/lib/mcp-auth";

export const metadata: Metadata = { title: "Authorize access", robots: { index: false, follow: false } };

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Confirm who you are",
  profile: "See your name",
  offline_access: "Renew this connection while your original sign-in remains active",
  "mcp:read": "Browse, search, download, and read accessible files, including PDF text",
  "mcp:write": "Create, rename, move, and upload files and folders",
  "mcp:share": "Create and revoke public share links",
  "mcp:trash": "Move files and folders to Trash",
};

export default async function McpConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const oauthQuery = oauthQueryFromSearchParams(params);
  if (!(await getSession())) redirect(oauthQuery ? `/login?${oauthQuery}` : "/login");

  const clientId = typeof params.client_id === "string" ? params.client_id : "";
  const scopes = [...new Set((typeof params.scope === "string" ? params.scope : "").split(/\s+/).filter(Boolean))];
  const elevated = scopes.some((scope) => scope === "mcp:write" || scope === "mcp:share" || scope === "mcp:trash");
  let clientName = "";
  try {
    if (!oauthQuery || !scopes.includes("mcp:read") || scopes.some((scope) => !SCOPE_DESCRIPTIONS[scope])) throw new Error("Invalid request");
    // This endpoint verifies the provider's signed, expiring query. Never show
    // an Allow button for unsigned scope/client details or an unknown client.
    const client = await getAuth().api.getOAuthClientPublicPrelogin({
      body: { client_id: clientId, oauth_query: oauthQuery }, headers: await headers(),
    });
    clientName = client.client_name || client.client_uri || clientId;
  } catch {
    return <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-3 px-5">
      <h1 className="text-xl font-medium">Authorization request unavailable</h1>
      <p>This request is invalid, expired, or could not be verified. Return to your assistant and reconnect to Orole Drive.</p>
    </main>;
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-7 bg-background px-5 py-12">
      <div className="flex items-center gap-2.5"><Cloud className="size-6 text-primary" aria-hidden="true" /><span className="text-sm font-medium">Orole Drive</span></div>
      <Card className="w-full max-w-md rounded-xl shadow-[0_2px_8px_rgb(0_0_0/.05)] [--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(6)]">
        <CardHeader>
          <div className="flex size-11 items-center justify-center rounded-full bg-muted"><ShieldCheck className="size-5 text-primary" aria-hidden="true" /></div>
          <CardTitle className="mt-3">Allow access to your drive?</CardTitle>
          <CardDescription className="break-all"><span className="font-medium text-foreground">{clientName}</span> wants to connect to your Orole Drive.</CardDescription>
          <CardDescription className="break-all">Client ID: {clientId}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm">Requested permissions:</p>
          <ul className="flex flex-col gap-2 text-sm">
            {scopes.filter((scope) => SCOPE_DESCRIPTIONS[scope]).map((scope) => (
              <li key={scope} className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span>{SCOPE_DESCRIPTIONS[scope]}</span></li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Read-only access is the default. Additional identity claims are not shared. Signing out of Orole Drive ends access for this connection.</p>
          {elevated && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Only allow the requested access if you want this assistant to change your drive. Trash and public sharing also require a separate confirmation for each action.</p>}
        </CardContent>
        <CardFooter>
          <ConsentActions oauthQuery={oauthQuery} scopes={scopes} />
        </CardFooter>
      </Card>
    </div>
  );
}
