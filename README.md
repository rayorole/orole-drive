# Orole Drive

Private shared family storage at https://drive.orole.be. Every verified `@orole.be` member can manage the same files and folders. Public links expose only the selected file, without requiring sign-in.

## Stack

Next.js App Router, TypeScript, Better Auth email OTP, Resend, Neon Postgres with Drizzle, Cloudflare R2, TanStack Query and server actions. Route handlers provide OAuth/MCP and authenticated scheduled cleanup. Upload bytes go directly from the browser to R2; metadata and permission checks use authenticated server actions.

The interface uses shadcn/Base UI, Cubby UI progress, loading.dev Ring indicators, Motion and CSS transitions, with system/light/dark themes and reduced-motion support. Its compact sidebar, neutral surfaces and interaction timing adapt the [agent-builder reference](https://agent-builder-ui-one.vercel.app/). File rows use one shared hover, focus and pressed background across all columns. Modal and menu transitions follow [transitions.dev](https://transitions.dev/). PDFs render locally with React-PDF/PDF.js; document bytes are not sent to a third-party viewer.

All Sonner notifications and the upload panel share the same neutral popover surface, rounded border and shadow in both themes. Status is conveyed by text and small icon accents, not colored backgrounds; success uses the same blue checkmark as completed uploads.

## Local setup

Install Node.js 24 and provide these environment variables in `.env.local` (never commit their values):

- `DATABASE_URL`: PostgreSQL connection string, pooled for application traffic.
- `DATABASE_URL_UNPOOLED`: direct connection used for migrations, optional if `DATABASE_URL` is direct.
- `BETTER_AUTH_SECRET`: cryptographically random secret, at least 32 characters.
- `BETTER_AUTH_URL`: `http://localhost:3000` locally; `https://drive.orole.be` in production.
- `RESEND_API_KEY`: key permitted to send from the verified `orole.be` domain.
- `RESEND_FROM`: `Orole Drive <drive@orole.be>`.
- `R2_ENDPOINT`: account S3 endpoint, `https://<account-id>.r2.cloudflarestorage.com`.
- `R2_BUCKET`: private bucket name (`data-orole` in production).
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: bucket-scoped object read/write credentials.
- `VIRUSTOTAL_API_KEY`: optional; enables hash-report lookup and explicitly approved file submissions.
- `CRON_SECRET`: strong random secret required for Vercel's authenticated daily Trash cleanup.
- `AI_GATEWAY_API_KEY`: optional; Vercel AI Gateway key used to score file risk with TypeSafe's Jev model. Deployments on Vercel can use OIDC instead.

```sh
npm ci
npm run db:migrate
npm run dev
```

`postinstall` copies PDF.js character maps, fonts and image decoders into ignored `public/pdf-assets/`. The PDF worker is bundled by Next.js.

```sh
npm test
npm run lint
npm run build
npm start
```

Generate a migration after changing a schema with `npm run db:generate`; inspect it before `npm run db:migrate`.

## Access and storage

- Sign-in requires a six-digit emailed code. Only the exact `orole.be` domain is accepted, not suffix lookalikes or subdomains. Codes expire after ten minutes, are stored hashed, have bounded verification attempts and are single-use. Sending and verification are throttled in Postgres.
- Nested folders support multi-selection, recursive ZIP downloads, bulk moves with cycle prevention, list/grid views, breadcrumbs and sorting. Search spans accessible folders, with compact Cubby UI segmented filters for file type, modified dates, size and tags.
- Trash supports restoring subtrees to their original location (or the root when unavailable). Public links are revoked on trashing and are not restored. The daily 03:00 UTC Vercel job permanently purges items after 30 days; durable deletion markers allow retries without restoring partially removed files.
- Folder passwords are checked on the server for every descendant operation, including search, downloads, previews, ZIP manifests and MCP. Unlocks are session-bound, versioned, throttled and expire after one hour or session expiry. Adding a password revokes descendant public links; locking or rotating it invalidates grants.
- Favorites and Recent activity are per member. Details provides tags, notes and folder colors. Keyboard shortcuts: `/` search, `F` filters, `F2` rename, `Delete` Trash, `Space` preview, and `Ctrl/Cmd+K` commands. Clipboard file/screenshot pasting uploads into the current folder.
- Files are private by default. Public link tokens are unguessable and revocable. Revocation blocks new access immediately; an already-issued storage URL can remain usable for at most 60 seconds. Previously downloaded copies cannot be recalled.
- Shared pages identify the link creator by their verified email, captured server-side when the link is created. Managing an existing link preserves its original attribution; revoking it clears that attribution, and creating a new link captures the new sharing member. Historical links with unknown attribution omit the byline rather than guessing an identity.
- Image, audio, video and PDF previews use short-lived read URLs. Text/code previews are bounded to 512 KiB; HTML and SVG render as source text, never executable documents. Eligible raster files get bounded private thumbnails. Public shares offer downloadable QR codes and image/video/PDF embeds; only the embed route allows framing. Browser codec support still governs audio/video playback.
- Maximum individual upload size is 5 GiB. Up to three files are processed at once, with at most four active R2 upload requests across the entire queue. The panel shows each file’s live transfer rate, sampled every 500 ms over a rolling three-second window. Uploads do not resume after closing the page. Folder uploads/drops preserve hierarchy; empty folders are retained when the browser exposes directory entries.
- Files of 64 MiB or more use parallel 16 MiB multipart uploads. Only the server can complete them, after validating every part’s number, length and ETag; completion publishes directly into `files/` without a second copy. Part URLs expire after 24 hours. Cancellation aborts the multipart upload and invalidates its remaining part URLs. Parallelism can improve throughput, but cannot exceed the connection’s upload bandwidth.
- Smaller files use single PUT tickets, valid for one hour, writing only to `uploads/`. Finalization checks metadata and size, conditionally copies into `files/`, and commits the database record. Reusing a PUT ticket cannot overwrite a finalized file. Existing in-progress single uploads continue using this path regardless of size.
- Configure the R2 lifecycle rule `orole-upload-staging` to expire **only `uploads/` after one day**. Do not expire completed objects in `files/`. Keep the bucket’s seven-day incomplete-multipart abort rule as a backstop. Pending database uploads older than 24 hours are pruned on drive listing or upload initiation. The staging lifecycle also catches late single PUTs after cancellation/deletion.
- Apply the checked-in `r2-cors.json` to the bucket. It allows the canonical domain, Vercel production alias and localhost, with signed PUT/GET/HEAD and range requests. Keep the bucket private; do not enable an R2 public development URL.

## VirusTotal and memory safety

Opening a private file's Details can look up its SHA-256 report; automatic hashing is limited to 100 MiB. File contents are submitted only after a signed-in writer confirms that VirusTotal may retain and distribute them to security partners and customers. Public share visitors can read saved status but cannot submit files or trigger file downloads for scanning.

**Scan priority.** Every new upload, and up to ten never-assessed files per folder listing, gets a risk level. Local checks flag programs, scripts, macro documents, disk images, archives, double extensions (`invoice.pdf.exe`), names padded to hide their extension, and a declared type that doesn't match the name. Jev (`typesafe-ai/jev` via the AI SDK's `experimental_evaluate`) then scores the file 0–3 and estimates whether it is disguised. Disguise evidence is always high risk; otherwise a score of 2 or more (or likely disguise) is high, and anything that can run code is at least medium. High-risk files are looked up on VirusTotal by hash straight away, before any other file, and show an amber shield with the reasons; medium ones get "Scan for viruses — suggested" in their menu. Only the name, extension, declared type, size and local signals are sent to Jev, never contents. Files in password-protected folders are skipped. Without a gateway key, the local checks alone decide the level.

VirusTotal submissions are limited to **650 MB (650,000,000 bytes)**, independently of the drive's 5 GiB storage limit. Larger files are rejected before opening a storage request. Eligible uploads use native HTTPS and backpressure-aware multipart streaming, with exact byte-count checks, cancellation, deadlines, and at most two active file streams per server process. Analysis IDs are saved so pending scans can refresh without resubmitting the file. “No detections” is not a guarantee of safety.

Development disables Next.js `serverComponentsHmrCache`: its default behavior retains even `no-store` fetch responses. Scan traffic also bypasses Next's patched fetch, which can buffer streaming request bodies while calculating cache keys. Do not replace the native transport with a server-side `fetch` upload or an eager `ReadableStream.start` loop.

The scan regression uses synthetic bytes and a stalled destination, never real uploads or API credentials:

```sh
node --max-old-space-size=128 --conditions=react-server --import tsx --test src/lib/virustotal.test.ts
```

## MCP access

Connect through the sidebar's **Connect an agent** dialog to `https://drive.orole.be/api/mcp`. The endpoint uses the installed SDK's MCP 2026-07-28 stateless HTTP profile; clients must support that version, OAuth authorization code with S256 PKCE, and form elicitation for Trash/sharing. Use a registered client or an HTTPS Client ID Metadata Document; unauthenticated dynamic client registration is not enabled.

Access defaults to `mcp:read`. Separately consent to `mcp:write`, `mcp:share` or `mcp:trash` when needed. Trash/sharing require signed, short-lived confirmations bound to the session, client, operation and item version. Tokens and refreshes require the original live family session; signing out revokes access. Folder passwords and all normal storage permissions still apply.

Tools cover listing/searching, metadata, bounded text/image/PDF reading, download links, folder creation, writing, renaming, moving, Trash, sharing and storage usage. Resources are `drive://root`, `drive://file/<id>` and `drive://folder/<id>`; prompts cover summaries, duplicate discovery and cleanup suggestions. PDF text extraction is limited to 5 MiB, 20 pages and 64,000 characters, without OCR.

## Deployment

The private GitHub repository is https://github.com/rayorole/orole-drive, connected to the Vercel project `orole-drive`. Production uses the `drive.orole.be` custom domain, the Neon integration and the private R2 bucket. Set production environment variables through Vercel, not source files. For a new environment, apply migrations before deploying. The build does not run migrations implicitly.

Use `gh` to publish commits and `vercel --prod` to deploy from the project directory. Preview deployments need their own canonical auth URL and R2 CORS origin before testing sign-in/uploads; production credentials are not automatically copied to previews.

## Component credits

The authentication form uses the [Rare UI OTP Input](https://www.rareui.com/components/otpinput) by Swami Malode, installed from `swamimalode07/rare-ui/otp-input` and adapted for this application’s theme, responsive layout and accessibility. It retains the rolling digits and sliding caret, with reduced-motion support. [Rare UI](https://rareui.com/) supplies the component under its MIT + Commons Clause license with attribution required. Shared loading indicators use [loading.dev Ring](https://loading.dev/).
