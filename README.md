# Orole Drive

Private shared family storage at https://drive.orole.be. Every verified `@orole.be` member can manage the same files and folders. Public links expose only the selected file, without requiring sign-in.

## Stack

Next.js App Router, TypeScript, Better Auth email OTP, Resend, Neon Postgres with Drizzle, Cloudflare R2, TanStack Query and server actions. There are no application API route handlers. Upload bytes go directly from the browser to R2; metadata and permission checks use authenticated server actions.

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
- The drive supports nested folders, search, recent files, list/grid views, renaming, downloads and permanent deletion. Nonempty folders must be emptied first; deleting an otherwise empty folder cancels its unfinished uploads.
- Files are private by default. Public link tokens are unguessable and revocable. Revocation blocks new access immediately; an already-issued storage URL can remain usable for at most 60 seconds. Previously downloaded copies cannot be recalled.
- Shared pages identify the link creator by their verified email, captured server-side when the link is created. Managing an existing link preserves its original attribution; revoking it clears that attribution, and creating a new link captures the new sharing member. Historical links with unknown attribution omit the byline rather than guessing an identity.
- Image, audio, video and PDF previews use short-lived read URLs. Other formats remain downloadable. Browser codec support still governs audio/video playback. PDF annotations/scripts are not executed. Encrypted PDFs should be downloaded and opened locally.
- Maximum individual upload size is 5 GiB. Up to three files are processed at once, with at most four active R2 upload requests across the entire queue. The panel shows each file’s live transfer rate, sampled every 500 ms over a rolling three-second window. Uploads do not resume after closing the page. Folder drag-and-drop is intentionally rejected; create the destination folder and drop its files instead.
- Files of 64 MiB or more use parallel 16 MiB multipart uploads. Only the server can complete them, after validating every part’s number, length and ETag; completion publishes directly into `files/` without a second copy. Part URLs expire after 24 hours. Cancellation aborts the multipart upload and invalidates its remaining part URLs. Parallelism can improve throughput, but cannot exceed the connection’s upload bandwidth.
- Smaller files use single PUT tickets, valid for one hour, writing only to `uploads/`. Finalization checks metadata and size, conditionally copies into `files/`, and commits the database record. Reusing a PUT ticket cannot overwrite a finalized file. Existing in-progress single uploads continue using this path regardless of size.
- Configure the R2 lifecycle rule `orole-upload-staging` to expire **only `uploads/` after one day**. Do not expire completed objects in `files/`. Keep the bucket’s seven-day incomplete-multipart abort rule as a backstop. Pending database uploads older than 24 hours are pruned on drive listing or upload initiation. The staging lifecycle also catches late single PUTs after cancellation/deletion.
- Apply the checked-in `r2-cors.json` to the bucket. It allows the canonical domain, Vercel production alias and localhost, with signed PUT/GET/HEAD and range requests. Keep the bucket private; do not enable an R2 public development URL.

## Deployment

The private GitHub repository is https://github.com/rayorole/orole-drive, connected to the Vercel project `orole-drive`. Production uses the `drive.orole.be` custom domain, the Neon integration and the private R2 bucket. Set production environment variables through Vercel, not source files. For a new environment, apply migrations before deploying. The build does not run migrations implicitly.

Use `gh` to publish commits and `vercel --prod` to deploy from the project directory. Preview deployments need their own canonical auth URL and R2 CORS origin before testing sign-in/uploads; production credentials are not automatically copied to previews.

## Component credits

The authentication form uses the [Rare UI OTP Input](https://www.rareui.com/components/otpinput) by Swami Malode, installed from `swamimalode07/rare-ui/otp-input` and adapted for this application’s theme, responsive layout and accessibility. It retains the rolling digits and sliding caret, with reduced-motion support. [Rare UI](https://rareui.com/) supplies the component under its MIT + Commons Clause license with attribution required. Shared loading indicators use [loading.dev Ring](https://loading.dev/).
