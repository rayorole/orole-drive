import assert from "node:assert/strict";
import test from "node:test";
import { uploadTicketNeedsRefresh } from "./upload-transfer";
import type { UploadTicket } from "./drive-types";

test("queued single uploads renew before expiry while fresh tickets remain usable", () => {
  const ticket: UploadTicket = { mode: "single", id: "upload", headers: {}, url: "https://storage.example/object?X-Amz-Date=20260925T120000Z&X-Amz-Expires=3600" };
  assert.equal(uploadTicketNeedsRefresh(ticket, Date.parse("2026-09-25T12:30:00Z")), false);
  assert.equal(uploadTicketNeedsRefresh(ticket, Date.parse("2026-09-25T12:59:00Z")), true);
  assert.equal(uploadTicketNeedsRefresh(ticket, Date.parse("2026-09-25T14:00:00Z")), true);
});

test("multipart ticket expiry follows its signed lifetime and completed parts need no renewal", () => {
  const ticket: UploadTicket = { mode: "multipart", id: "upload", partSize: 16 * 1024 * 1024, completedParts: [1], parts: [{ partNumber: 2, url: "https://storage.example/object?X-Amz-Date=20260925T120000Z&X-Amz-Expires=86400" }] };
  assert.equal(uploadTicketNeedsRefresh(ticket, Date.parse("2026-09-25T14:00:00Z")), false);
  assert.equal(uploadTicketNeedsRefresh(ticket, Date.parse("2026-09-26T12:00:00Z")), true);
  assert.equal(uploadTicketNeedsRefresh({ ...ticket, completedParts: [1, 2], parts: [] }, Date.parse("2026-09-26T12:00:00Z")), false);
});
