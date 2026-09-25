"use client";

import { useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";

export function ConsentActions({ oauthQuery, scopes }: { oauthQuery: string; scopes: string[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  function respond(accept: boolean, scope = "mcp:read") {
    setError("");
    startTransition(async () => {
      try {
        const { data, error: consentError } = await authClient.oauth2.consent({ accept, scope, claims: {}, oauth_query: oauthQuery });
        if (consentError || !data?.url) {
          setError(consentError?.message ?? "Could not finish authorization. Restart the connection in your assistant.");
          return;
        }
        window.location.assign(data.url);
      } catch {
        setError("Could not reach Orole Drive. Check your connection and try again.");
      }
    });
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" disabled={pending} onClick={() => respond(false)}><X data-icon="inline-start" />Deny</Button>
        <Button className="flex-1" disabled={pending} onClick={() => respond(true)}>{pending ? <Spinner /> : <Check data-icon="inline-start" />}Allow read only</Button>
      </div>
      {scopes.some((scope) => scope !== "mcp:read") && <Button variant="outline" disabled={pending} onClick={() => respond(true, scopes.join(" "))}>Allow requested permissions</Button>}
    </div>
  );
}
