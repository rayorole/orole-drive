import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { acceptedContent, createRequestStateCodec, inputRequired, McpServer, requireScopes, ResourceTemplate } from "@modelcontextprotocol/server";
import {
  cancelUpload,
  completeUpload,
  copyItems,
  createFolder,
  getDownloadUrl,
  getPreviewUrl,
  listDrive,
  moveItems,
  renameItem,
  setPublic,
  trashItems,
  beginUpload,
} from "@/app/actions/drive";
import { assertItemAccess, driveAction, getItemAccess, runWithDriveContext, withDriveTransaction } from "@/lib/drive-access";
import type { DriveActor } from "@/lib/drive-access";
import { DriveError } from "@/lib/drive-errors";
import { driveItems } from "@/lib/drive-schema";
import type { ActionResult, ConflictResolution, ConflictResolutions, DriveItem, UploadResolution } from "@/lib/drive-types";
import { getPreviewKind, readTextPreview } from "@/lib/file-preview";
import { downloadMcpBytes, extractMcpPdf, MCP_PDF_MAX_BYTES } from "@/lib/mcp-file-content";
import { toDriveItem } from "@/lib/storage";
import { getStorageUsage } from "@/app/actions/storage-usage";

const EMBEDDABLE_IMAGE_TYPES: Record<string, true> = {
  "image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true,
};
const MCP_IMAGE_EMBED_MAX_BYTES = 1_048_576;
const MCP_WRITE_FILE_MAX_BYTES = 2 * 1_048_576;

const idParam = z.uuid("Provide a valid file or folder id.");
const dateParam = z.iso.date();
const typeFilterParam = z.enum(["all", "folder", "image", "video", "audio", "pdf", "text", "code", "archive", "other"]);
const sortParam = z.enum(["name", "updatedAt", "size", "type"]);
const directionParam = z.enum(["asc", "desc"]);
const onConflictParam = z.enum(["replace", "keep-both", "skip"]).default("keep-both").describe(
  "When the destination already has an item with the same name: keep-both (default) numbers the incoming name, skip leaves the item out, replace moves the existing item to Trash (needs Trash access and the user's confirmation).",
);

function toolResult<T>(result: ActionResult<T>): CallToolResult {
  if (!result.success) {
    const lockedSuffix = result.lockedFolder ? ` (locked folder: "${result.lockedFolder.name}")` : "";
    return { content: [{ type: "text", text: `${result.error}${lockedSuffix}` }], isError: true };
  }
  const structured = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : undefined;
  const text = structured ? JSON.stringify(structured, null, 2) : "Done.";
  return structured ? { content: [{ type: "text", text }], structuredContent: structured } : { content: [{ type: "text", text }] };
}

async function getDriveItemInfo(id: string): Promise<ActionResult<DriveItem>> {
  return driveAction(async (ctx) => withDriveTransaction("read", async (tx) => {
    const [row] = await tx.select().from(driveItems).where(eq(driveItems.id, id)).limit(1);
    if (!row || row.state !== "complete") throw new DriveError("This file or folder is no longer available.");
    await assertItemAccess(tx, ctx, row);
    return { ...toDriveItem(row), ...await getItemAccess(tx, ctx, row) };
  }), "read");
}

async function readFileTool(actor: DriveActor, id: string): Promise<CallToolResult> {
  const info = await runWithDriveContext(actor, () => getDriveItemInfo(id));
  if (!info.success) return toolResult(info);
  const item = info.data;
  if (item.kind !== "file") return { content: [{ type: "text", text: "That id refers to a folder, not a file. Use list_folder instead." }], isError: true };

  const previewKind = getPreviewKind(item);
  if (previewKind === "text") {
    const preview = await runWithDriveContext(actor, () => getPreviewUrl(id));
    if (!preview.success || !preview.data.url) return toolResult(preview);
    const { text, truncated, encoding } = await readTextPreview(preview.data.url, AbortSignal.timeout(15_000));
    const note = truncated ? `\n\n[Truncated: this file is larger than the preview bound. Use get_download_link for the full file.]` : "";
    return { content: [{ type: "text", text: `${text}${note}` }], structuredContent: { encoding, truncated } };
  }
  if (previewKind === "pdf") {
    if (item.size <= 0 || item.size > MCP_PDF_MAX_BYTES) {
      return { content: [{ type: "text", text: "PDF text extraction is limited to files up to 5 MiB. Use get_download_link for this file." }], isError: true };
    }
    const download = await runWithDriveContext(actor, () => getDownloadUrl(id));
    if (!download.success) return toolResult(download);
    const extracted = await extractMcpPdf(await downloadMcpBytes(download.data.url, item.size));
    const note = extracted.truncated ? "\n\n[Truncated to 20 pages or 64,000 text characters. Use get_download_link for the original.]" : "";
    return { content: [{ type: "text", text: extracted.text + note }], structuredContent: { pagesRead: extracted.pagesRead, totalPages: extracted.totalPages, truncated: extracted.truncated } };
  }
  if (previewKind === "image" && item.mimeType && EMBEDDABLE_IMAGE_TYPES[item.mimeType] && item.size > 0 && item.size <= MCP_IMAGE_EMBED_MAX_BYTES) {
    const download = await runWithDriveContext(actor, () => getDownloadUrl(id));
    if (!download.success) return toolResult(download);
    const data = Buffer.from(await downloadMcpBytes(download.data.url, item.size)).toString("base64");
    return { content: [{ type: "image", data, mimeType: item.mimeType }] };
  }
  return {
    content: [{ type: "text", text: `This file (${item.mimeType ?? "unknown type"}, ${item.size} bytes) isn't supported for inline reading. Call get_download_link with id "${id}" for a short-lived download URL.` }],
    structuredContent: { mimeType: item.mimeType, size: item.size, useGetDownloadLink: true },
  };
}

async function writeFileTool(actor: DriveActor, input: { name: string; parentId: string | null; content: string; mimeType: string; onConflict?: UploadResolution }): Promise<CallToolResult> {
  const size = Buffer.byteLength(input.content, "utf8");
  if (size > MCP_WRITE_FILE_MAX_BYTES) {
    return { content: [{ type: "text", text: `That content is ${size} bytes, over the ${MCP_WRITE_FILE_MAX_BYTES}-byte limit for write_file. Upload larger files through the app instead.` }], isError: true };
  }
  const request = { name: input.name, size, mimeType: input.mimeType, parentId: input.parentId };
  let ticketResult = await runWithDriveContext(actor, () => beginUpload(request));
  const conflict = ticketResult.success ? undefined : ticketResult.conflicts?.[0];
  if (conflict) {
    if (!input.onConflict) {
      return { content: [{ type: "text", text: `${conflict.existingKind === "folder" ? "A folder" : "A file"} named “${conflict.name}” already exists there. Call write_file again with onConflict "replace" (a file's current contents are kept in its version history) or "keep-both" (saves under a numbered name).` }], isError: true };
    }
    if (input.onConflict === "replace" && conflict.existingKind === "folder") {
      return { content: [{ type: "text", text: `“${conflict.name}” is a folder, so write_file can't replace it. Use onConflict "keep-both", or move the folder to Trash first with trash_item.` }], isError: true };
    }
    ticketResult = await runWithDriveContext(actor, () => beginUpload({ ...request, resolution: input.onConflict }));
  }
  if (!ticketResult.success) return toolResult(ticketResult);
  const ticket = ticketResult.data;
  if (ticket.mode !== "single") {
    await runWithDriveContext(actor, () => cancelUpload(ticket.id)).catch(() => undefined);
    return { content: [{ type: "text", text: "That content unexpectedly needed a multipart upload. Try again with smaller content." }], isError: true };
  }
  try {
    const response = await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body: input.content });
    if (!response.ok) throw new Error(`The storage upload responded with status ${response.status}.`);
  } catch (error) {
    await runWithDriveContext(actor, () => cancelUpload(ticket.id)).catch(() => undefined);
    return { content: [{ type: "text", text: error instanceof Error ? error.message : "The upload failed." }], isError: true };
  }
  return toolResult(await runWithDriveContext(actor, () => completeUpload(ticket.id)));
}

async function folderSummaryPrompt(actor: DriveActor, folderId: string | null, instruction: string, project: (item: DriveItem) => Record<string, unknown>) {
  const listing = await runWithDriveContext(actor, () => listDrive({ folderId }));
  const body = listing.success ? JSON.stringify(listing.data.items.map(project), null, 2) : `(could not load folder: ${listing.error})`;
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text: `${instruction}\n\nFolder contents (JSON):\n${body}` } }] };
}

/** Builds a fresh MCP server for one HTTP request, with every tool/resource/prompt
 * closing over the already-authorized `actor` so every drive operation runs through
 * runWithDriveContext -> driveAction/withDriveTransaction, never a raw db call. */
export function createDriveMcpServer(actor: DriveActor): McpServer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("MCP confirmation signing is not configured.");
  const confirmation = createRequestStateCodec<{ operation: string; input: string }>({
    key: secret,
    ttlSeconds: 300,
    bind: (ctx) => JSON.stringify([actor.context.userId, actor.context.sessionId, ctx.http?.authInfo?.clientId, ctx.mcpReq.method]),
  });
  const server = new McpServer({ name: "orole-drive", version: "1.0.0" }, { requestState: { verify: confirmation.verify } });
  async function confirmAction(operation: string, input: string, message: string, ctx: ServerContext) {
    const state = ctx.mcpReq.requestState<{ operation: string; input: string }>();
    if (!state) return inputRequired({
      requestState: await confirmation.mint({ operation, input }, ctx),
      inputRequests: {
        confirm: inputRequired.elicit({
          message,
          requestedSchema: z.object({ confirm: z.boolean().describe("I understand and approve this exact change.") }),
        }),
      },
    });
    if (state.operation !== operation || state.input !== input) {
      return { content: [{ type: "text" as const, text: "The item or requested action changed. Request confirmation again." }], isError: true };
    }
    if (acceptedContent(ctx.mcpReq.inputResponses, "confirm", z.object({ confirm: z.boolean() }))?.confirm !== true) {
      return { content: [{ type: "text" as const, text: "Not confirmed. No changes were made." }] };
    }
    return null;
  }

  /**
   * Moves/copies never prompt over MCP: the first attempt reports any name conflicts, which all get `onConflict`.
   * Replace sends the existing items to Trash, so like trash_item it needs Trash access and the user's confirmation.
   */
  async function transferTool<T>(operation: string, input: { id: string; parentId: string | null; onConflict: ConflictResolution }, transfer: (resolutions?: ConflictResolutions) => Promise<ActionResult<T>>, ctx: ServerContext) {
    const first = await runWithDriveContext(actor, () => transfer());
    if (first.success || !first.conflicts?.length) return toolResult(first);
    if (input.onConflict === "replace") {
      if (!actor.capabilities.has("trash")) return { content: [{ type: "text" as const, text: "Replacing moves the existing item to Trash, which this connection isn't allowed to do. Use onConflict \"keep-both\" or \"skip\", or reconnect with Trash access." }], isError: true };
      const names = first.conflicts.map((conflict) => `"${conflict.name}"`).join(", ");
      const confirmationResult = await confirmAction(operation, JSON.stringify({ ...input, existing: first.conflicts.map((conflict) => conflict.existingId) }), `Replace ${names} in the destination? The existing ${first.conflicts.length === 1 ? "item moves" : "items move"} to Trash, where ${first.conflicts.length === 1 ? "it" : "they"} can be restored for 30 days.`, ctx);
      if (confirmationResult) return confirmationResult;
    }
    const resolutions: ConflictResolutions = Object.fromEntries(first.conflicts.map((conflict) => [conflict.id, input.onConflict]));
    return toolResult(await runWithDriveContext(actor, () => transfer(resolutions)));
  }

  server.registerTool("list_folder", {
    title: "List folder",
    description: "Lists the files and folders directly inside a folder, or the drive root when folderId is omitted. Locked, protected, and trashed items never appear.",
    inputSchema: z.object({
      folderId: idParam.nullable().optional().describe("Folder id to list; omit or null for the drive root."),
      sort: sortParam.optional(),
      direction: directionParam.optional(),
    }),
  }, async ({ folderId, sort, direction }) => toolResult(await runWithDriveContext(actor, () => listDrive({ folderId: folderId ?? null, sort, direction }))));

  server.registerTool("search_files", {
    title: "Search files",
    description: "Searches file and folder names across every folder this connection can access, with optional type/size/date filters and sorting.",
    inputSchema: z.object({
      query: z.string().trim().max(200).default(""),
      type: typeFilterParam.optional(),
      minSize: z.number().int().min(0).optional(),
      maxSize: z.number().int().min(0).optional(),
      after: dateParam.optional().describe("YYYY-MM-DD, inclusive lower bound on last modified date."),
      before: dateParam.optional().describe("YYYY-MM-DD, inclusive upper bound on last modified date."),
      sort: sortParam.optional(),
      direction: directionParam.optional(),
    }),
  }, async ({ query, type, minSize, maxSize, after, before, sort, direction }) =>
    toolResult(await runWithDriveContext(actor, () => listDrive({ search: query, type, minSize, maxSize, after, before, sort, direction }))));

  server.registerTool("get_file_info", {
    title: "Get file info",
    description: "Returns metadata (name, kind, size, mime type, timestamps, sharing/lock flags) for a single file or folder by id.",
    inputSchema: z.object({ id: idParam }),
  }, async ({ id }) => toolResult(await runWithDriveContext(actor, () => getDriveItemInfo(id))));

  server.registerTool("read_file", {
    title: "Read file",
    description: "Reads bounded text/code, extracts text from PDFs up to 5 MiB (20 pages / 64,000 characters; no OCR), and embeds safe images up to 1 MiB. Other files require get_download_link.",
    inputSchema: z.object({ id: idParam }),
  }, async ({ id }) => {
    try { return await readFileTool(actor, id); }
    catch { return { content: [{ type: "text", text: "This file could not be read. It may be encrypted, malformed, or unavailable. Use get_download_link to open the original." }], isError: true }; }
  });

  server.registerTool("get_download_link", {
    title: "Get download link",
    description: "Returns a short-lived (60 second) signed download URL for a file.",
    inputSchema: z.object({ id: idParam }),
  }, async ({ id }) => toolResult(await runWithDriveContext(actor, () => getDownloadUrl(id))));

  server.registerTool("create_folder", {
    title: "Create folder",
    description: "Creates a new folder.",
    inputSchema: z.object({ name: z.string().trim().min(1).max(255), parentId: idParam.nullable().optional() }),
    scopeChallenge: requireScopes("mcp:write"),
  }, async ({ name, parentId }) => toolResult(await runWithDriveContext(actor, () => createFolder({ name, parentId: parentId ?? null }))));

  server.registerTool("write_file", {
    title: "Write file",
    description: `Writes a small text or code file (up to ${MCP_WRITE_FILE_MAX_BYTES / 1_048_576}MB) with the given contents. If the name is already taken in the folder, the call fails unless onConflict is set.`,
    inputSchema: z.object({
      name: z.string().trim().min(1).max(255),
      parentId: idParam.nullable().optional(),
      content: z.string(),
      mimeType: z.string().trim().toLowerCase().max(127).default("text/plain"),
      onConflict: z.enum(["replace", "keep-both"]).optional().describe(
        "When a file with this name already exists: replace saves these contents as its new version (the previous contents stay in its version history), keep-both saves under a numbered name. Folders can't be replaced.",
      ),
    }),
    scopeChallenge: requireScopes("mcp:write"),
  }, async ({ name, parentId, content, mimeType, onConflict }) => writeFileTool(actor, { name, parentId: parentId ?? null, content, mimeType, onConflict }));

  server.registerTool("rename_item", {
    title: "Rename item",
    description: "Renames a file or folder.",
    inputSchema: z.object({ id: idParam, name: z.string().trim().min(1).max(255) }),
    scopeChallenge: requireScopes("mcp:write"),
  }, async ({ id, name }) => toolResult(await runWithDriveContext(actor, () => renameItem({ id, name }))));

  server.registerTool("move_item", {
    title: "Move item",
    description: "Moves a file or folder to a different parent folder, or to the drive root when parentId is null. Returns what moved (and from where) plus any items replaced.",
    inputSchema: z.object({ id: idParam, parentId: idParam.nullable(), onConflict: onConflictParam }),
    scopeChallenge: requireScopes("mcp:write"),
  }, async (input, ctx) => transferTool("move_item", input, (resolutions) => moveItems({ ids: [input.id], parentId: input.parentId, resolutions }), ctx));

  server.registerTool("copy_item", {
    title: "Copy item",
    description: "Copies a file or folder (with everything inside) into a folder, or the drive root when parentId is null. Copying into the item's own folder names the copy \"name (copy)\". Returns the new copy's id.",
    inputSchema: z.object({ id: idParam, parentId: idParam.nullable(), onConflict: onConflictParam }),
    scopeChallenge: requireScopes("mcp:write"),
  }, async (input, ctx) => transferTool("copy_item", input, (resolutions) => copyItems({ ids: [input.id], parentId: input.parentId, resolutions }), ctx));

  server.registerTool("trash_item", {
    title: "Trash item",
    description: "Moves a file or folder (including its contents) to Trash after explicit user confirmation. Automatically purged after 30 days; recoverable until then.",
    inputSchema: z.object({ id: idParam }),
    annotations: { destructiveHint: true },
    scopeChallenge: requireScopes("mcp:trash"),
  }, async ({ id }, ctx) => {
    const info = await runWithDriveContext(actor, () => getDriveItemInfo(id));
    if (!info.success) return toolResult(info);
    const confirmationResult = await confirmAction("trash_item", JSON.stringify({ id, updatedAt: info.data.updatedAt }), `Move "${info.data.name}"${info.data.kind === "folder" ? " and everything inside it" : ""} to Trash? It can be restored for 30 days, then is permanently deleted.`, ctx);
    if (confirmationResult) return confirmationResult;
    return toolResult(await runWithDriveContext(actor, () => trashItems([id])));
  });

  server.registerTool("share_file", {
    title: "Share file or folder",
    description: "Creates or revokes a public link for a file or folder after explicit user confirmation. Anyone with an enabled link can view and download the file, or everything inside the folder except password-protected subfolders. Items in password-protected folders cannot be shared. Optional expiry: 60 to 2,592,000 seconds; otherwise no expiry.",
    inputSchema: z.object({
      id: idParam,
      enabled: z.boolean().default(true),
      expiresIn: z.number().int().min(60).max(2_592_000).optional(),
    }),
    annotations: { destructiveHint: true },
    scopeChallenge: requireScopes("mcp:share"),
  }, async ({ id, enabled, expiresIn }, ctx) => {
    const info = await runWithDriveContext(actor, () => getDriveItemInfo(id));
    if (!info.success) return toolResult(info);
    const subject = info.data.kind === "folder" ? `the folder "${info.data.name}" and everything inside it (except password-protected subfolders)` : `"${info.data.name}"`;
    const message = enabled
      ? `Make ${subject} public to anyone with the link${expiresIn ? ` for ${expiresIn} seconds` : " with no expiry"}? The link can be forwarded to people outside your family.`
      : `Revoke the public link for "${info.data.name}"? People using that link will lose access.`;
    const confirmationResult = await confirmAction("share_file", JSON.stringify({ id, enabled, expiresIn, updatedAt: info.data.updatedAt }), message, ctx);
    if (confirmationResult) return confirmationResult;
    return toolResult(await runWithDriveContext(actor, () => setPublic({ id, enabled, expiresIn })));
  });

  server.registerTool("storage_summary", {
    title: "Storage summary",
    description: "Returns bytes used against the drive's storage limit and your own limit, a breakdown by file type (current files) plus Trash, old versions and uploads in progress, usage per family member, and the largest files you can access. Sizes are in bytes.",
    inputSchema: z.object({}),
  }, async () => toolResult(await runWithDriveContext(actor, () => getStorageUsage())));

  server.registerResource("drive-root", "drive://root", {
    title: "Drive root", description: "Files and folders accessible at the root of the drive.",
  }, async (uri) => {
    const result = await runWithDriveContext(actor, () => listDrive({ folderId: null }));
    if (!result.success) throw new Error(result.error);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result.data, null, 2) }] };
  });

  server.registerResource("drive-file", new ResourceTemplate("drive://file/{id}", { list: undefined }), {
    title: "Drive file",
    description: "Metadata for a single drive file or folder, addressed by id.",
  }, async (uri, variables) => {
    const id = idParam.parse(Array.isArray(variables.id) ? variables.id[0] : variables.id);
    const result = await runWithDriveContext(actor, () => getDriveItemInfo(id));
    if (!result.success) throw new Error(result.error);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result.data, null, 2) }] };
  });

  server.registerResource("drive-folder", new ResourceTemplate("drive://folder/{id}", { list: undefined }), {
    title: "Drive folder",
    description: "Listing of a single drive folder's direct children, addressed by id.",
  }, async (uri, variables) => {
    const id = idParam.parse(Array.isArray(variables.id) ? variables.id[0] : variables.id);
    const result = await runWithDriveContext(actor, () => listDrive({ folderId: id }));
    if (!result.success) throw new Error(result.error);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result.data, null, 2) }] };
  });

  server.registerPrompt("summarize-folder", {
    title: "Summarize folder",
    description: "Summarize what's inside a drive folder.",
    argsSchema: z.object({ folderId: idParam.nullable().optional() }),
  }, async ({ folderId }) => folderSummaryPrompt(
    actor, folderId ?? null,
    "Summarize what's in this drive folder for a family member skimming it quickly. Group by type, call out anything unusually large or old, and keep it under 150 words.",
    ({ name, kind, size, mimeType, updatedAt }) => ({ name, kind, size, mimeType, updatedAt }),
  ));

  server.registerPrompt("find-duplicates", {
    title: "Find duplicates",
    description: "Look for files that appear to be duplicates within a drive folder.",
    argsSchema: z.object({ folderId: idParam.nullable().optional() }),
  }, async ({ folderId }) => folderSummaryPrompt(
    actor, folderId ?? null,
    "Look for likely duplicate files in this drive folder listing: same or near-identical name, or same size with a similar name. List each suspected duplicate group with the item ids and a one-line reason. These are unverified candidates, not proven duplicates. Never trash anything without the user's explicit confirmation.",
    ({ id, name, kind, size }) => ({ id, name, kind, size }),
  ));

  server.registerPrompt("cleanup-suggestions", {
    title: "Cleanup suggestions",
    description: "Suggest files that might be safe to move to Trash to free up space.",
    argsSchema: z.object({ folderId: idParam.nullable().optional() }),
  }, async ({ folderId }) => folderSummaryPrompt(
    actor, folderId ?? null,
    "Review this drive folder listing and suggest files that might be safe to move to Trash (old temp/export files, oversized duplicates, stale downloads). Name each item id and your reason. Be conservative: when unsure, don't suggest it. Never trash anything without the user's explicit confirmation. Trash is recoverable for 30 days before permanent deletion; moving to Trash does not immediately free storage.",
    ({ id, name, kind, size, updatedAt }) => ({ id, name, kind, size, updatedAt }),
  ));

  return server;
}
