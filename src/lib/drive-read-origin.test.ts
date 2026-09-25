import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "@/app/api/drive/read/[operation]/route";

test("read transport trusts configured public origins, not internal or spoofed proxy hosts", async () => {
  const names = ["BETTER_AUTH_URL", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.BETTER_AUTH_URL = "https://drive.example";
  process.env.VERCEL_URL = "drive-deployment.vercel.app";
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "drive-production.vercel.app";
  try {
    const request = (origin: string, extraHeaders: Record<string, string> = {}) => POST(
      new Request("http://127.0.0.1:3000/api/drive/read/unknown", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Orole-Read": "1", ...extraHeaders },
        body: JSON.stringify({ args: [] }),
      }),
      { params: Promise.resolve({ operation: "unknown" }) },
    );
    // A trusted browser reaches operation validation even behind an internal upstream URL.
    assert.equal((await request("https://drive.example")).status, 404);
    assert.equal((await request("https://drive-deployment.vercel.app")).status, 404);
    assert.equal((await request("https://drive-production.vercel.app")).status, 404);
    assert.equal((await request("http://127.0.0.1:3000")).status, 403);
    assert.equal((await request("https://attacker.example", { "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "https" })).status, 403);
    assert.equal((await request("https://drive.example.attacker.example")).status, 403);
    assert.equal((await request("null")).status, 403);
    assert.equal((await request("https://drive.example", { "X-Orole-Read": "" })).status, 403);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
