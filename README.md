# Orole Drive

Private family storage at https://drive.orole.be. Verified members from approved email domains own their files and folders and choose who can access them: only themselves, all drive members, selected accounts or an explicit public link.

## Stack

Next.js App Router, TypeScript, Better Auth email OTP, Resend, Neon Postgres with Drizzle, Cloudflare R2, TanStack Query and server actions. Authenticated browser reads use a typed, private/no-store HTTP route rather than the serialized Server Action queue; mutations remain server actions. Route handlers also provide OAuth/MCP and scheduled cleanup. Upload bytes go directly from the browser to R2.

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
- `CRON_SECRET`: strong random secret required for Vercel's authenticated daily Trash cleanup and search indexing.
- `AI_GATEWAY_API_KEY`: optional; Vercel AI Gateway key used to score file risk with TypeSafe's Jev model. Deployments on Vercel can use OIDC instead.
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_API_TOKEN`: optional; turn on AI search. The token needs **Workers AI: Read** and **Vectorize: Edit**. Without both, search features stay hidden and nothing is sent anywhere.
- `VECTORIZE_INDEX`: Vectorize index name, default `orole-drive-search`.
- `OPENROUTER_API_KEY`: optional; image captions for search and **Ask your drive** answers. Set it in Vercel too.
- `SEARCH_CAPTION_MODEL` and `SEARCH_CHAT_MODEL`: OpenRouter model slugs, default `anthropic/claude-haiku-4.5` and `z-ai/glm-5.3-flash`.
- `DRIVE_STORAGE_QUOTA_BYTES`: whole-drive storage limit in bytes, default 1 TiB.
- `DRIVE_MEMBER_QUOTA_BYTES`: storage limit per contributing member in bytes, default 250 GiB.

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

- Sign-in requires a six-digit emailed code and an email domain in `EMAIL_DOMAIN_WHITELIST` in `src/lib/auth-policy.ts`, currently `orole.be` and `ronzani.be`. Matching is case-insensitive and exact: suffix lookalikes and subdomains are rejected. The same whitelist governs OTP requests, account creation/updates, sessions, drive visibility and member selection. Codes expire after ten minutes, are stored hashed, have bounded verification attempts and are single-use. Sending and verification are throttled in Postgres.
- Nested folders support multi-selection, recursive ZIP downloads, bulk moves with cycle prevention, list/grid views, breadcrumbs and sorting. Search spans accessible folders, with compact Cubby UI segmented filters for file type, modified dates, size and tags.
- **Ownership and sharing:** new top-level files and folders are owner-private. New children inherit their folder's access, including future uploads into shared folders; explicitly choosing **Only me** stops inheritance. Owners can share with all verified drive members or selected registered accounts, with **Viewer** or **Editor** access. Viewers can read, download and make their own copies; editors can also change contents and metadata and perform authorized file operations. Only the direct owner can change sharing, public links or folder passwords.
- Ownership is separate from who supplied the current version's bytes: replacing content or restoring an old version never transfers ownership. The explorer shows **Owner** immediately before **Date modified**. Copying creates a new item owned by the copier, private at the top level or inheriting its destination folder.
- Sharing badges appear beside names in list/grid views and pinned folders: a globe marks public access, and a people icon marks all-member or selected-member access. Labels distinguish the audience and inherited access. Explicit private overrides, expired links, protected public paths and Trash do not retain a misleading public badge.
- Item permissions are enforced server-side, including search, previews, downloads, versions, uploads, ZIP manifests and MCP. Directly shared nested items can appear at the recipient's top level without exposing private ancestor names. Folder ownership grants editor access through inherited descendants, not ownership; another uploader's explicit private child remains private.
- Trash supports restoring subtrees to their original location (or the root when unavailable). Public links are revoked on trashing and are not restored. The daily 03:00 UTC Vercel job permanently purges items after 30 days; durable deletion markers allow retries without restoring partially removed files.
- **Empty Trash** permanently deletes accessible Trash contents after typing DELETE. Locked items are kept and reported. Deleting items disappear immediately; removal continues in the background and the daily cleanup retries unfinished deletions. Permanent deletion cannot be undone.
- Moves, drag-and-drop and copy/paste ask **Replace / Keep both / Skip** for destination name conflicts, ignoring case. Replace sends the existing destination item to Trash; Keep both numbers the incoming name. Copies pasted into their original folder use “(copy)” automatically. Move, Trash and paste notifications offer **Undo**, with `Ctrl/Cmd+Z` available for ten seconds. Undoing a copy sends its copies to Trash rather than permanently deleting potentially edited content.
- The **Activity** sidebar view records who uploaded, created, renamed, moved, copied, shared, trashed, restored, deleted or managed file versions and folder passwords. Filter by member or action; Details shows an item's last ten events. History is retained for 365 days. Events disappear when current item access is revoked or the item is permanently deleted; inaccessible source/ancestor references are redacted.
- The sidebar storage section uses separators and a horizontal bar for accessible usage by file type. Clicking it opens quota limits, accessible category/member breakdowns, Trash, versions, pending uploads and the twenty largest accessible files. Private bytes belonging to others are not disclosed but still count toward enforced whole-drive quotas; the unfilled bar is not guaranteed free space. Pending uploads, Trash and versions consume quota.
- Folder passwords are checked on the server for every descendant operation, including search, downloads, previews, ZIP manifests and MCP. Unlocks are session-bound, versioned, throttled and expire after one hour or session expiry. Adding a password revokes descendant public links; locking or rotating it invalidates grants.
- Favorites and Recent activity are per member. Details provides tags, notes and folder colors. Keyboard shortcuts: `/` search, `F` filters, `F2` rename, `Delete` Trash, `Space` preview, and `Ctrl/Cmd+K` commands. Clipboard file/screenshot pasting uploads into the current folder.
- File/folder opening controls play one sound for a double-click sequence, rather than one per pointer press. Single clicks, touch taps and keyboard activation retain their feedback.
- Dialogs keep long filenames within their width: compact headers truncate names, while multiline titles and descriptions wrap unbroken names without pushing controls outside the dialog.
- **Pinned folders** are personal, database-synced sidebar shortcuts, separate from Favorites. Use a folder's Actions menu to pin it. Each sidebar shortcut is full-width; right-click it for a right-side menu with **Unpin from sidebar** and **Edit details**. Pins follow renames and moves; trashed or inaccessible folders are hidden without discarding the preference. The navigation area scrolls independently of storage and sign-out.
- Folder **Details & tags** lets owners and editors change the folder color and choose or clear an emoji using the searchable, keyboard-accessible Frimousse picker. Appearance saves immediately, is visible to people with access, survives copying, and appears in pinned folders and public folder views. Frimousse loads emoji catalog data from the Emojibase CDN and caches it locally; folder contents are not sent there.
- Public links are explicit, separate from authenticated member roles. Tokens are unguessable and revocable; public visitors get read/download access, not editor rights. Switching away from Public link in access settings revokes that item's token. Revocation blocks new access immediately; an already-issued storage URL can remain usable for at most 60 seconds. Previously downloaded copies cannot be recalled.
- Folder links allow browsing subfolders, previewing files and downloading the current folder as a ZIP. Only descendants with an uninterrupted **Inherit** chain are included; explicit Only me/member/account settings and password-protected subfolders stop public folder access. A child's own explicit public link remains independent. Access is rechecked against the shared root on every request; ancestors outside the share are never exposed. Folder listings show up to 1,000 entries; ZIP manifests allow up to 20,000 items. Share links support expiry and revocation; embeds and automatic share-time virus submissions remain file-only.
- Shared pages identify the link creator by their verified email, captured server-side when the link is created. Managing an existing link preserves its original attribution; revoking it clears that attribution, and creating a new link captures the new sharing member. Historical links with unknown attribution omit the byline rather than guessing an identity.
- Image, audio, video and PDF previews use short-lived read URLs. Text/code previews are bounded to 512 KiB; HTML and SVG render as source text, never executable documents. Eligible raster files get bounded private thumbnails. Public shares offer downloadable QR codes and image/video/PDF embeds; only the embed route allows framing. Browser codec support still governs audio/video playback.
- **Office previews** render `.docx`, `.xlsx` and `.pptx` locally in private dialogs and public file/folder shares, without sending documents to an online viewer. Word provides formatted reading content, tables and raster images. Excel offers worksheet tabs with cached cell values; formulas never execute. PowerPoint offers slide navigation with positioned text, basic shapes and raster images. These are reading previews, not Office-perfect rendering: advanced formatting, charts, SmartArt, animations and other unsupported objects can differ or be omitted. Legacy binary and macro-enabled formats remain download-only.
- Office preview limits: 20 MiB input, 40 MiB actual expanded ZIP contents, 1,500 ZIP entries, 8 MiB per part and 2 MiB per XML part. Excel shows up to 40 visible sheets, rows 1–200 and columns A–AX; slides are limited to 100 with 500 rendered objects each. PNG/JPEG/GIF images are bounded by pixel/allocation limits. External relationships and active content are blocked, Word markup is sanitized, and object URLs are revoked on close. Oversized, encrypted or malformed files show an error while the original remains downloadable.
- Maximum individual upload size is 5 GiB. Up to three files transfer at once, with at most four active R2 upload requests across the queue. Ordinary files reserve in batches of up to twenty, returning individual validation/conflict results; queued tickets renew before expiry without creating another reservation. The panel shows each file’s live transfer rate, sampled every 500 ms over a rolling three-second window. Folder uploads/drops preserve hierarchy, including empty folders, and prepare up to thirty-two directories per transactional dependency-ordered batch.
- Same-name uploads offer **Replace / Keep both / Skip**, including apply-to-all for batches. Folder uploads merge into existing writable same-named folders. Replacing a file preserves its ID and keeps previous contents in **Version history**: download, restore or delete earlier versions. Up to twenty earlier versions are retained; restoring saves the displaced current contents as another version. Content changes invalidate scan/risk results and select content-specific thumbnail keys. Pruned version objects have durable cleanup intents for retry.
- **Interrupted uploads** lists the member's unfinished uploads, including ones started on another device, for up to 24 hours. Resume requires selecting the original local file again; name and size must match, plus last-modified time when retained by this browser. Multipart resumes send only missing or invalid parts; small single-PUT uploads resend the whole file and recover already-staged contents through verified completion. Discard cancels the upload. Locked destinations are omitted until unlocked.
- Files of 64 MiB or more use parallel 16 MiB multipart uploads. Only the server can complete them, after validating every part’s number, length and ETag; completion publishes directly into `files/` without a second copy. Part URLs expire after 24 hours. Cancellation aborts the multipart upload and invalidates its remaining part URLs. Parallelism can improve throughput, but cannot exceed the connection’s upload bandwidth.
- Smaller files use single PUT tickets, valid for one hour, writing only to `uploads/`. Finalization verifies metadata and size, copies into a separately journaled immutable publication key in `files/`, then rechecks live permissions before publishing. Old and new deployment finalizers cannot overwrite each other's published bytes, and repeated completion does not create duplicate versions.
- Configure the R2 lifecycle rule `orole-upload-staging` to expire **only `uploads/` after one day**. Do not expire completed objects in `files/`. Keep the bucket’s seven-day incomplete-multipart abort rule as a backstop. Scheduled cleanup prunes expired pending uploads and retries journaled cancellations/version cleanup; tombstones survive outstanding signed tickets. The staging lifecycle also catches late single PUTs after cancellation/deletion.
- Apply the checked-in `r2-cors.json` to the bucket. It allows the canonical domain, Vercel production alias and localhost, with signed PUT/GET/HEAD and range requests. Keep the bucket private; do not enable an R2 public development URL.

## Performance and concurrency

Folder hover and opening share the same short-lived listing cache. Storage reports have their own query key and refresh for relevant content, name and access changes, not favorites or unrelated metadata. Visible thumbnail signing is batched, and access changes abort old reads before clearing sensitive caches. Read responses expose total duration through `Server-Timing`.

Listings bulk-load ancestors, evaluate access together and join favorites/scan/risk metadata. Session validation is reused only inside its exact transaction; mutable ACLs and password grants are not cached across checks. R2 requests and thumbnail processing run outside the global hierarchy lock. A separate pool, bounded to three connections per process, holds object-specific advisory claims while short hierarchy transactions authorize and publish. Database connection capacity must account for both this pool and the five-connection application pool.

The optional database regressions require an explicitly supplied local `TEST_DATABASE_URL` with all migrations applied. They use unique fixtures and isolate the S3 boundary; normal `npm test` does not fall back to the production database.


## VirusTotal and memory safety

Opening a private file's Details can look up its SHA-256 report; automatic hashing is limited to 100 MiB. File contents are submitted only after a signed-in writer confirms that VirusTotal may retain and distribute them to security partners and customers. Public share visitors can read saved status but cannot submit files or trigger file downloads for scanning.

**Scan priority.** Every new upload, and up to ten never-assessed files per folder listing, gets a risk level. Local checks flag programs, scripts, macro documents, disk images, archives, double extensions (`invoice.pdf.exe`), names padded to hide their extension, and a declared type that doesn't match the name. Jev (`typesafe-ai/jev` via the AI SDK's `experimental_evaluate`) then scores the file 0–3 and estimates whether it is disguised. Disguise evidence is always high risk; otherwise a score of 2 or more (or likely disguise) is high, and anything that can run code is at least medium. High-risk files are looked up on VirusTotal by hash straight away, before any other file, and show an amber shield with the reasons; medium ones get "Scan for viruses — suggested" in their menu. Only the name, extension, declared type, size and local signals are sent to Jev, never contents. Files in password-protected folders are skipped. Without a gateway key, the local checks alone decide the level.

VirusTotal submissions are limited to **650 MB (650,000,000 bytes)**, independently of the drive's 5 GiB storage limit. Larger files are rejected before opening a storage request. Eligible uploads use native HTTPS and backpressure-aware multipart streaming, with exact byte-count checks, cancellation, deadlines, and at most two active file streams per server process. Analysis IDs are saved so pending scans can refresh without resubmitting the file. “No detections” is not a guarantee of safety.

Development disables Next.js `serverComponentsHmrCache`: its default behavior retains even `no-store` fetch responses. Scan traffic also bypasses Next's patched fetch, which can buffer streaming request bodies while calculating cache keys. Do not replace the native transport with a server-side `fetch` upload or an eager `ReadableStream.start` loop.

The scan regression uses synthetic bytes and a stalled destination, never real uploads or API credentials:

```sh
node --max-old-space-size=128 --conditions=react-server --import tsx --test src/lib/virustotal.test.ts
```

## AI search

With Cloudflare configured, file contents become searchable by meaning and by exact words, for members in the app and for MCP agents. Everything is on by default; an owner can choose **Exclude from AI search** in a folder's Actions menu (Security) to keep that folder and everything inside it out. Details shows each file's state: Indexed, Queued, Failed (retried) or Skipped with the reason.

In the app, typing three or more characters in the drive search box keeps the name results and adds **Found inside files** below them: each match shows its folder path, a passage with the query terms highlighted and its location (page, sheet, slide or caption). Select a match to preview it, or the folder button to open its folder. In `Ctrl/Cmd+K`, **Search inside files for “…”** runs the same search.

- **What is indexed:** text and code (first 512 KiB), PDFs up to 5 MiB (text layer of the first 20 pages, 64,000 characters, no OCR), `.docx`/`.xlsx`/`.pptx` within the Office preview limits (one passage group per sheet or slide, cached cell values only), and JPEG/PNG/GIF/WebP/AVIF images up to 10 MiB through a short AI caption plus any clearly visible text. Only current contents are indexed, never old versions. Items in Trash, pending uploads and anything inside a password-protected folder are never extracted, embedded or returned, even while the folder is unlocked.
- **Pipeline:** contents are split into ~1,500-character passages (200 overlap; the first starts with the file name, folder paths are not embedded) and embedded with Workers AI `@cf/baai/bge-m3` (1,024 dimensions, multilingual) into Cloudflare Vectorize. Postgres keeps the passages with a `simple` (unstemmed, Dutch/English-safe) full-text index. Queries fuse both rankings (reciprocal rank fusion); if Cloudflare is unavailable, keyword matches still return and the result says so.
- **Access:** Cloudflare stores only vectors keyed by passage id, with no names, text or permissions. Every hit is re-authorized in Postgres for the searching member or MCP connection at query time (item ACLs, Trash, exclusion and passwords); anything else is dropped without a trace. Folder paths show only folders the member can read. Search is limited to 20 queries per minute per member and 500 characters.
- **Freshness:** uploads, new versions, restores, renames, copies and MCP `write_file` queue a file and index it right after the response. Trash, permanent deletion, exclusion, adding a folder password and moving into a protected or excluded folder remove passages from Postgres in the same transaction; their Vectorize vectors are journaled and deleted afterwards, with retries. A contents change during extraction discards the stale text. The daily 04:00 UTC job (`/api/cron/search-index`, schedule in `vercel.json`) retries failures (up to five attempts, with back-off), deletes leftover vectors and backfills files uploaded before search was enabled.
- **Privacy and cost:** file text is sent to Cloudflare Workers AI for embedding. Image bytes are re-encoded (metadata such as GPS is stripped, at most 1,568 px) and sent through OpenRouter to Anthropic for captions. Embedding costs about $0.012 per million tokens; each image caption is a small Haiku request. Leave the Cloudflare variables unset to keep search off entirely.

One-time setup, then set the environment variables and run migrations:

```sh
npx wrangler vectorize create orole-drive-search --dimensions=1024 --metric=cosine
```

### Ask your drive

With OpenRouter also configured, **Ask AI** in the top header (or `Ctrl/Cmd+K` → Ask AI) opens a right-hand chat sheet. Its title opens searchable conversation history grouped by date; header controls start a new conversation, rename/delete it, and expand the sheet. The sheet keeps its state while closed, so answers keep streaming; opening a cited file closes the sheet first. The UI uses [assistant-ui](https://www.assistant-ui.com/) elements and thread primitives in `src/components/assistant-ui/` on an external-store runtime backed by the drive's API; nothing is sent to assistant-ui's cloud.

- `POST /api/drive/chat` authenticates like the read route and streams NDJSON text, citations and tool steps. The model (`SEARCH_CHAT_MODEL` via OpenRouter) can browse folders with `list_drive_items`, find files/folders by name with `find_drive_items`, search indexed contents with `search_drive`, read excerpts with `read_file_excerpt` (up to 8,000 characters), compare text versions with `compare_versions`, and show comparison cards with `present_comparison`. Folder and filename discovery does not depend on content indexing; metadata and file tools enforce authorization and search eligibility.
- The composer supports `@` member mentions with the same DiceBear profile pictures used elsewhere in the drive, restricting searches to the mentioned members' files without granting access. Attach up to three files, totaling 3 MB, for a single question: text, PDF, Office documents and images are supported. Attachment contents are not saved to chat history or uploaded into the drive; only their names and metadata are retained.
- The system prompt tells the model to answer from tool results or the question's attachments, say when it has no answer, reply in the question's language, and treat file text as untrusted instructions.
- Chats are private to each member. Questions are saved before streaming; answers, citations and tool steps are saved when complete. Responses support copying, thumbs-up/down feedback and regenerating the last answer. Regeneration replaces that answer; one-shot attachments must be attached again. Limits: 30 questions per hour per member, 4,000 characters per question.
- `Ctrl/Cmd+F` inside the sheet searches the current conversation, with matching snippets and navigation. Sources show one card per file or folder, even when several numbered citations refer to different passages in the same file. Inline citation numbers and quoted passages remain available. Tool activity, failures, comparisons and version diffs appear inline.
- Thinking and writing use one compact inline spinner and status label, replaced by tool activity while a tool runs. The spinner respects reduced-motion preferences and disappears when generation stops.
- Citations and file-related tool steps are re-authorized every time a chat loads. Unavailable sources cannot open; their quoted passages, paths and diffs are removed. The last ten messages are sent as history; earlier answers with inaccessible sources are replaced by a placeholder.
- **Known limitation:** saved answer text may quote a file the member later loses access to. Its citations stop opening, but the quoted text stays in their own chat history until they delete the chat.
- **Privacy:** permission can be remembered for this session or this browser. Search passages, excerpts, version content and question attachments are sent through OpenRouter to the configured model provider. The composer capability panel shows drive tools and configured services.

## MCP access

Connect through the sidebar's **Connect an agent** dialog to `https://drive.orole.be/api/mcp`. The endpoint uses the installed SDK's MCP 2026-07-28 stateless HTTP profile; clients must support that version, OAuth authorization code with S256 PKCE, and form elicitation for Trash/sharing. Use a registered client or an HTTPS Client ID Metadata Document; unauthenticated dynamic client registration is not enabled.

Access defaults to `mcp:read`. Separately consent to `mcp:write`, `mcp:share` or `mcp:trash` when needed. Trash/sharing require signed, short-lived confirmations bound to the session, client, operation and item version. Tokens and refreshes require the original live family session; signing out revokes access. Folder passwords and all normal storage permissions still apply.

Tools cover listing/searching, metadata, bounded text/image/PDF reading, download links, folder creation, writing, renaming, moving, Trash, sharing and storage usage. `search_files` matches names only; with AI search configured, `semantic_search` searches contents (query, `limit` 1–25, optional `folderId` and `type`) and returns files with matching passages under the same access rules, and the `ask_drive` prompt tells an agent to search, read the best hits and answer with file citations. Resources are `drive://root`, `drive://file/<id>` and `drive://folder/<id>`; prompts cover summaries, duplicate discovery and cleanup suggestions. PDF text extraction is limited to 5 MiB, 20 pages and 64,000 characters, without OCR.
- MCP `share_file` also accepts folders. `move_item` and `copy_item` accept `onConflict` (Keep both by default); Replace requires trash permission and confirmation. `write_file` supports file replacement with version history. `storage_summary` includes drive/member quotas, category totals, member usage and the largest accessible files.

## Deployment

Run `npm run db:migrate` before starting or deploying code that changes the schema. Migration `0008_pinned_folders_emoji.sql` adds pins and folder emoji metadata; `0009_owner_access.sql` adds owner/member permissions, backfills owners from recorded creators, makes existing roots private and nested items inherit, and preserves existing explicit public links. Unknown/deleted owners are never guessed or reassigned; their items fail closed. Apply the matching application code with the migration: older code does not enforce the new ACLs. Running new code without its migrations makes file queries fail.

Migration `0010_storage_work.sql` adds the durable upload/cleanup journal, multipart-initiation intent and isolated single-PUT publication keys. Apply it before deploying this performance release. It is additive for the preceding application, and new code reconciles unfinished uploads created before or during rollout. R2 credentials must permit prefix-scoped multipart listing/abort as well as object reads/writes.

Migration `0011_search_index.sql` adds `drive_items.search_excluded` and the search tables (`drive_search_docs`, `drive_search_chunks` with a generated `tsvector`, `drive_search_orphans`). It is additive. After deploying with Cloudflare configured, existing files are backfilled by the daily job in batches.

Migration `0012_drive_chat.sql` adds `drive_chats` and `drive_chat_messages` for **Ask your drive**. It is additive.

Migration `0013_chat_steps_feedback.sql` adds tool steps, attachment metadata and response feedback to chat messages. It is additive; run `npm run db:migrate` against production **before** deploying the updated Ask AI sheet.

The private GitHub repository is https://github.com/rayorole/orole-drive, connected to the Vercel project `orole-drive`. Production uses the `drive.orole.be` custom domain, the Neon integration and the private R2 bucket. Vercel functions run in Frankfurt (`fra1`), alongside Neon's `eu-central-1` database; `vercel.json` pins the region. Set production environment variables through Vercel, not source files. For a new environment, apply migrations before deploying. The build does not run migrations implicitly.

Use `gh` to publish commits and `vercel --prod` to deploy from the project directory. Preview deployments need their own canonical auth URL and R2 CORS origin before testing sign-in/uploads; production credentials are not automatically copied to previews.

## Component credits

The authentication form uses the [Rare UI OTP Input](https://www.rareui.com/components/otpinput) by Swami Malode, installed from `swamimalode07/rare-ui/otp-input` and adapted for this application’s theme, responsive layout and accessibility. It retains the rolling digits and sliding caret, with reduced-motion support. [Rare UI](https://rareui.com/) supplies the component under its MIT + Commons Clause license with attribution required. Shared loading indicators use [loading.dev Ring](https://loading.dev/).
