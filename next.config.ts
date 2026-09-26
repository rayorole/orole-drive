import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pdfjs-dist"],
  // PDF text extraction runs for MCP reads, chat excerpts, the search sweeper and indexing
  // scheduled with after() by the workspace's Server Actions (which run in the "/" function).
  outputFileTracingIncludes: Object.fromEntries(["/", "/api/mcp", "/api/cron/search-index", "/api/drive/chat"].map((route) => [route, [
    "./public/pdf-assets/standard_fonts/**/*",
    "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  ]])),
  experimental: {
    // A confirmed chat attachment is at most 3 MiB; base64 plus action framing stays below this cap.
    serverActions: { bodySizeLimit: "4.5mb" },
    // HMR otherwise caches even no-store file streams in development.
    serverComponentsHmrCache: false,
  },
  async headers() {
    return [
      {
        source: "/((?!s/[^/]+/embed(?:$|/)).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // Public embeds are meant to be framed cross-origin; only this route skips X-Frame-Options.
        source: "/s/:token/embed",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
