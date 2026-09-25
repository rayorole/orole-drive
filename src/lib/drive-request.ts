import "server-only";

/**
 * Browser-only drive routes accept JSON from the deployment's own origins with a custom header,
 * which cross-site forms and simple requests cannot send. Reverse proxies can give Next an internal
 * request URL, so only deployment-owned configuration selects trusted origins; forwarded headers cannot add one.
 */
export function isTrustedDriveRequest(request: Request, header: string): boolean {
  const origin = request.headers.get("origin");
  const publicUrls = [
    process.env.BETTER_AUTH_URL ?? (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : undefined),
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
    process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`,
  ];
  return publicUrls.some((url) => url && origin === new URL(url).origin)
    && request.headers.get(header) === "1"
    && request.headers.get("content-type")?.split(";", 1)[0].trim() === "application/json";
}
