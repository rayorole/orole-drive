# Orole Drive

Private shared family storage at https://drive.orole.be. Every verified `@orole.be` member can manage the same files and folders. Public links expose only the selected file, without requiring sign-in.

## Stack

Next.js App Router, TypeScript, Better Auth email OTP, Resend, Neon Postgres with Drizzle, Cloudflare R2, TanStack Query and server actions. There are no application API route handlers. Upload bytes go directly from the browser to R2; metadata and permission checks use authenticated server actions.

The interface uses shadcn/Base UI, Cubby UI progress, loading.dev spinners, Motion and CSS transitions, with system/light/dark themes and reduced-motion support. Its compact sidebar, neutral surfaces and interaction timing adapt the [agent-builder reference](https://agent-builder-ui-one.vercel.app/). Modal and menu transitions follow [transitions.dev](https://transitions.dev/). PDFs render locally with React-PDF/PDF.js; document bytes are not sent to a third-party viewer.

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
npm run lint
npm run build
npm start
```

Generate a migration after changing a schema with `npm run db:generate`; inspect it before `npm run db:migrate`.

## Access and storage

- Sign-in requires a six-digit emailed code. Only the exact `orole.be` domain is accepted, not suffix lookalikes or subdomains. Codes expire after ten minutes, are stored hashed, have bounded verification attempts and are single-use. Sending and verification are throttled in Postgres.
- The drive supports nested folders, search, recent files, list/grid views, renaming, downloads and permanent deletion. Nonempty folders must be emptied first; deleting an otherwise empty folder cancels its unfinished uploads.
- Files are private by default. Public link tokens are unguessable and revocable. Revocation blocks new access immediately; an already-issued storage URL can remain usable for at most 60 seconds. Previously downloaded copies cannot be recalled.
- Image, audio, video and PDF previews use short-lived read URLs. Other formats remain downloadable. Browser codec support still governs audio/video playback. PDF annotations/scripts are not executed. Encrypted PDFs should be downloaded and opened locally.
- Maximum individual upload size is 5 GiB. Three uploads can run concurrently, with progress and cancellation. Uploads do not resume after closing the page. Folder drag-and-drop is intentionally rejected; create the destination folder and drop its files instead.
- PUT tickets expire after one hour and write only to `uploads/`. Finalization checks the object metadata and size, conditionally copies it into `files/`, and commits its database record. Reusing a PUT ticket cannot overwrite a finalized file.
- Configure the R2 lifecycle rule `orole-upload-staging` to expire **only `uploads/` after one day**. Do not expire `files/`. Expired pending database records are pruned on drive listing or upload initiation. The staging lifecycle also catches late PUTs after cancellation/deletion.
- Apply the checked-in `r2-cors.json` to the bucket. It allows the canonical domain, Vercel production alias and localhost, with signed PUT/GET/HEAD and range requests. Keep the bucket private; do not enable an R2 public development URL.

## Deployment

The private GitHub repository is https://github.com/rayorole/orole-drive, connected to the Vercel project `orole-drive`. Production uses the `drive.orole.be` custom domain, the Neon integration and the private R2 bucket. Set production environment variables through Vercel, not source files. For a new environment, apply migrations before deploying. The build does not run migrations implicitly.

Use `gh` to publish commits and `vercel --prod` to deploy from the project directory. Preview deployments need their own canonical auth URL and R2 CORS origin before testing sign-in/uploads; production credentials are not automatically copied to previews.
