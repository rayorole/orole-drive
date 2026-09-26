import assert from "node:assert/strict";
import test from "node:test";
import { hydrateChatStep } from "./chat-hydration";
import type { DriveChatStep } from "./drive-types";

test("revoked rich sources remove image text, table cells and approval previews", () => {
  const steps: DriveChatStep[] = [
    { id: "image", tool: "read_image", status: "done", label: "Receipt", itemId: "file", asset: { itemId: "file", alt: "Receipt", ocr: "Sensitive receipt", description: "Private image" } },
    { id: "table", tool: "drive_activity", status: "done", label: "Activity", sourceItemIds: ["file"], table: { title: "Activity", columns: ["Name"], rows: [["Sensitive filename"]], truncated: false } },
    { id: "tree", tool: "show_drive_tree", status: "done", label: "Private folder", itemId: "folder", tree: { title: "Private folder", nodes: [{ id: "file", parentId: "folder", kind: "file", name: "Sensitive filename", size: 1 }], hasMore: false } },
    { id: "approval", tool: "rename_item", status: "done", label: "Rename", approval: { request: { operation: "rename_item", itemId: "file", name: "New name" }, title: "Sensitive filename", details: ["Private destination"], status: "pending", expiresAt: "2099-01-01T00:00:00Z", snapshots: [{ itemId: "file", updatedAt: "2026-01-01T00:00:00Z" }] } },
  ];
  const [image, table, tree, approval] = steps.map((step) => hydrateChatStep(step, new Map()));
  assert.equal(image.asset?.item, null);
  assert.equal(image.asset?.ocr, undefined);
  assert.equal(image.asset?.description, undefined);
  assert.equal(table.table, undefined);
  assert.equal(tree.tree, undefined);
  assert.equal(approval.approval, undefined);
});

test("generated root-file previews are withheld when their content source is revoked", () => {
  const step: DriveChatStep = {
    id: "generated", tool: "create_file", status: "done", label: "Create summary",
    approval: {
      request: { operation: "create_file", name: "summary.txt", parentId: null, content: "Confidential source-derived text", mimeType: "text/plain" },
      title: "Create summary", details: [], status: "pending", expiresAt: "2099-01-01T00:00:00Z",
      snapshots: [], sourceItemIds: ["revoked-source"],
    },
  };
  assert.equal(hydrateChatStep(step, new Map()).approval, undefined);
});
