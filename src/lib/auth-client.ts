import { createAuthClient } from "better-auth/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

// Used only by the /mcp/consent screen: oauthProviderClient() auto-forwards the
// signed oauth_query from the current page's URL to the consent endpoint.
export const authClient = createAuthClient({
  plugins: [oauthProviderClient()],
});
