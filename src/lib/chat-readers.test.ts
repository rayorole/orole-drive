import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { EMAIL_DOMAIN_WHITELIST } from "./auth-policy";
import { session, user } from "./auth-schema";
import { prepareChatAttachments } from "./chat-attachments";
import { decodeDocumentText, readDocumentLines } from "./chat-document";
import { prepareChatImage, requireChatFile } from "./chat-reader-access";
import { createChatReaderTools } from "./chat-reader-tools";
import { calculateSpreadsheet, parseDelimitedSpreadsheet, parseXlsxSpreadsheet, readSpreadsheetRange, selectSpreadsheetSheet, spreadsheetMonth, spreadsheetRange } from "./chat-spreadsheet";
import type { ChatToolContext } from "./chat-tool-context";
import type { Database } from "./db";
import type { DriveContext } from "./drive-access";
import { driveItems } from "./drive-schema";
import { extractPdfText } from "./pdf-text";

const signal = new AbortController().signal;
const encode = (text: string) => new TextEncoder().encode(text);

async function workbook(date1904 = false) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  const files: Record<string, string> = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="${date1904 ? 1 : 0}"/><sheets><sheet name="Budget &amp; plan" sheetId="1" r:id="sheet"/><sheet name="Private" sheetId="2" state="hidden" r:id="hidden"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/data.xml"/><Relationship Id="hidden" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/hidden.xml"/><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    "xl/styles.xml": '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    "xl/sharedStrings.xml": '<sst><si><t>Date</t></si><si><t>Amount</t></si><si><t>Team</t></si><si><t>North</t></si><si><t>South</t></si></sst>',
    "xl/worksheets/data.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" s="1"><v>${date1904 ? 44561 : 46023}</v></c><c r="B2"><v>10.25</v></c><c r="C2" t="s"><v>3</v></c></row><row r="3"><c r="A3" t="d"><v>2026-01-31</v></c><c r="B3"><f>SUM(B2,5)</f><v>15.25</v></c><c r="C3" t="s"><v>3</v></c></row><row r="4"><c r="A4" t="d"><v>2026-02-01</v></c><c r="B4" t="inlineStr"><is><t>pending</t></is></c><c r="C4" t="s"><v>4</v></c></row><row r="5"><c r="A5" t="d"><v>2026-02-02</v></c><c r="B5"/><c r="C5" t="s"><v>4</v></c></row><row r="6"><c r="A6" t="d"><v>2026-02-03</v></c><c r="B6"><f>1/0</f></c><c r="C6" t="s"><v>4</v></c></row><row r="7"><c r="A7" s="1"><v>60</v></c><c r="B7" t="b"><v>1</v></c></row><row r="201"><c r="B201"><v>-4</v></c></row></sheetData></worksheet>`,
    "xl/worksheets/hidden.xml": '<worksheet><sheetData><row r="1"><c r="A1"><v>9999</v></c></row></sheetData></worksheet>',
  };
  for (const [path, text] of Object.entries(files)) await writer.add(path, new Uint8ArrayReader(encode(text)));
  return writer.close();
}

function pdf(texts: string[]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${texts.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${texts.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  texts.forEach((text, index) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const offset = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(body);
}

test("PDF ranges reach later pages and resume a clipped page without losing text", async () => {
  const texts = Array.from({ length: 25 }, (_, index) => `Page ${index + 1} content`);
  const late = await extractPdfText(pdf(texts), { startPage: 21, endPage: 23, signal });
  assert.deepEqual(late.pages.map(({ page, text }) => [page, text.trim()]), [[21, texts[20]], [22, texts[21]], [23, texts[22]]]);
  assert.equal(late.totalPages, 25);
  assert.equal(late.truncated, true);
  assert.deepEqual(late.nextCursor, { page: 24, offset: 0 });
  const last = await extractPdfText(pdf(texts), { startPage: 25, endPage: 30, signal });
  assert.equal(last.truncated, false);
  assert.equal(last.nextCursor, null);
  const part = await extractPdfText(pdf(["abcdefghij"]), { maxCharacters: 4, signal });
  assert.deepEqual(part.nextCursor, { page: 1, offset: 4 });
  const rest = await extractPdfText(pdf(["abcdefghij"]), { startPage: part.nextCursor!.page, offset: part.nextCursor!.offset, signal });
  assert.equal((part.pages[0].text + rest.pages[0].text).trim(), "abcdefghij");
  assert.equal(rest.truncated, false);
  await assert.rejects(extractPdfText(pdf(texts), { startPage: 26 }), /25 pages/);
  await assert.rejects(extractPdfText(pdf(texts), { startPage: 1, endPage: 21 }), /1–20/);
  await assert.rejects(extractPdfText(pdf(texts), { offset: 99999 }), /beyond/);
});

test("base64 PDF attachments expose readable text for the model", async () => {
  const bytes = Buffer.from(pdf(["Attachment receipt total 42.50"]));
  const prepared = await prepareChatAttachments([{ name: "receipt.pdf", mimeType: "application/pdf", data: bytes.toString("base64") }], signal);
  assert.ok(prepared.parts.some((part) => part.type === "text" && part.text.includes("Attachment receipt total 42.50")));
});

test("text ranges preserve inclusive lines and continue within a long line", () => {
  const text = "first\r\nabcdefghij\r\nlast";
  const part = readDocumentLines(text, { startLine: 2, endLine: 2, maxCharacters: 4 });
  assert.deepEqual(part.lines, [{ line: 2, offset: 0, text: "abcd" }]);
  assert.equal(part.totalLines, 3);
  assert.deepEqual(part.nextCursor, { startLine: 2, offset: 4 });
  const rest = readDocumentLines(text, part.nextCursor!);
  assert.deepEqual(rest.lines, [{ line: 2, offset: 4, text: "efghij" }, { line: 3, offset: 0, text: "last" }]);
  assert.equal(rest.truncated, false);
  assert.throws(() => readDocumentLines(text, { startLine: 4 }));
  assert.throws(() => readDocumentLines(text, { endLine: 201 }));
  assert.throws(() => readDocumentLines(text, { offset: 6 }));
  assert.equal(decodeDocumentText(new Uint8Array([255, 254, 72, 0, 105, 0])), "Hi");
  assert.throws(() => decodeDocumentText(new Uint8Array([255, 0, 0])));
});

test("CSV cells, escaped delimiters and every arithmetic operation use parsed values", () => {
  const sheet = parseDelimitedSpreadsheet('Team,Amount,Date,Note\r\nNorth,10.5,2026-01-02,"hello, world"\r\nNorth,-2,2026-01-03,"line one\nline ""two"""\r\nSouth,4,2026-02-01,\r\nSouth,,2026-02-02,\r\nSouth,pending,03/02/2026,').sheets[0];
  assert.equal(sheet.cells.get("D2")?.value, "hello, world");
  assert.equal(sheet.cells.get("D3")?.value, 'line one\nline "two"');
  for (const [operation, expected] of [["sum", 12.5], ["count", 3], ["average", 12.5 / 3], ["min", -2], ["max", 10.5]] as const) {
    const result = calculateSpreadsheet(sheet, { operation, column: "Amount" });
    assert.deepEqual(result.results, [{ group: null, value: expected, numericCells: 3, blankCells: 1, nonNumericCells: 1 }]);
  }
  assert.deepEqual(calculateSpreadsheet(sheet, { operation: "sum", column: "B", groupBy: { column: "Team" } }).results.map(({ group, value }) => [group, value]), [["North", 8.5], ["South", 4]]);
  const monthly = calculateSpreadsheet(sheet, { operation: "sum", column: "B", groupBy: { column: "C", period: "month" } });
  assert.deepEqual(monthly.results.map(({ group, value }) => [group, value]), [["2026-01", 8.5], ["2026-02", 4]]);
  assert.equal(monthly.invalidGroupRows, 1);
  assert.equal(calculateSpreadsheet(sheet, { operation: "sum", column: "B", range: "A3:C4" }).results[0].value, 2);
  assert.throws(() => calculateSpreadsheet(sheet, { operation: "sum", column: "B", range: "C2:D5" }));
  assert.equal(spreadsheetMonth("2026-02-30"), null);
  assert.equal(spreadsheetMonth("2026-13"), null);
  assert.equal(spreadsheetMonth("2026-12"), "2026-12");
  assert.throws(() => parseDelimitedSpreadsheet('A,B\n"unfinished'));
  assert.throws(() => parseDelimitedSpreadsheet('A,B\n"closed"junk,1'));
  assert.equal(parseDelimitedSpreadsheet("A;B\n1;2", ";").sheets[0].cells.get("B2")?.value, 2);
});

test("range pagination never drops rows, blank-only averages are null and oversized arithmetic refuses partial totals", () => {
  const sheet = parseDelimitedSpreadsheet("Name,Value\nfirst,1\nsecond,2\nthird,3").sheets[0];
  const first = readSpreadsheetRange(sheet, { range: "A2:B4", maxRows: 2 });
  assert.deepEqual(first.rows, [[2, "first", 1], [3, "second", 2]]);
  assert.deepEqual(first.nextCursor, { startRow: 4 });
  assert.deepEqual(readSpreadsheetRange(sheet, { range: "A2:B4", ...first.nextCursor! }).rows, [[4, "third", 3]]);
  assert.deepEqual(spreadsheetRange(sheet, "$A$2:$B$4"), { startRow: 2, endRow: 4, startColumn: 1, endColumn: 2 });
  assert.throws(() => spreadsheetRange(sheet, "B2:A1"));
  assert.throws(() => spreadsheetRange(sheet, "A1:ZZ100000"));
  assert.throws(() => spreadsheetRange(sheet, "XFE1"));
  assert.throws(() => readSpreadsheetRange(sheet, { range: "A1:AE2" }));
  assert.throws(() => readSpreadsheetRange(sheet, { startRow: 5 }));
  const empty = parseDelimitedSpreadsheet("Amount\n\n").sheets[0];
  assert.equal(calculateSpreadsheet(empty, { operation: "average", column: "A" }).results[0].value, null);
  const compensated = parseDelimitedSpreadsheet("Amount\n10000000000000000\n1\n-10000000000000000").sheets[0];
  assert.equal(calculateSpreadsheet(compensated, { operation: "sum", column: "A" }).results[0].value, 1);
  const noHeaders = parseDelimitedSpreadsheet("4\n6").sheets[0];
  assert.equal(calculateSpreadsheet(noHeaders, { operation: "sum", column: "A", headerRow: null }).results[0].value, 10);
  const money = parseDelimitedSpreadsheet("Date,Amount\n2026-08-10,10.10\n2026-08-20,20.20\n2026-09-20,42.50").sheets[0];
  assert.deepEqual(calculateSpreadsheet(money, { operation: "sum", column: "Amount", groupBy: { column: "Date", period: "month" } }).results.map(({ group, value }) => [group, value]), [["2026-08", 30.3], ["2026-09", 42.5]]);
  const average = parseDelimitedSpreadsheet("Amount\n0.1\n0.1\n0.1").sheets[0];
  assert.equal(calculateSpreadsheet(average, { operation: "average", column: "A" }).results[0].value, 0.1);
});

test("XLSX uses named visible sheets, sparse cells, cached formulas, and real Excel calendar dates", async () => {
  const book = await parseXlsxSpreadsheet(await workbook(), signal);
  assert.deepEqual(book.sheets.map(({ name }) => name), ["Budget & plan"]);
  const sheet = selectSpreadsheetSheet(book, "Budget & plan");
  assert.throws(() => selectSpreadsheetSheet(book, "Private"));
  assert.equal(sheet.cells.get("A2")?.value, "2026-01-01");
  assert.equal(sheet.cells.get("A7")?.type, "error", "Excel's nonexistent 1900-02-29 is not treated as a real date");
  const total = calculateSpreadsheet(sheet, { operation: "sum", column: "Amount", range: "A1:C201" });
  assert.equal(total.results[0].value, 21.5);
  assert.equal(total.cachedFormulaCells, 1);
  assert.equal(total.missingFormulaCells, 1);
  const monthly = calculateSpreadsheet(sheet, { operation: "sum", column: "B", range: "A1:C6", groupBy: { column: "Date", period: "month" } });
  assert.deepEqual(monthly.results.map(({ group, value }) => [group, value]), [["2026-01", 25.5], ["2026-02", 0]]);
  assert.deepEqual(readSpreadsheetRange(sheet, { range: "B201:B201" }).rows, [[201, -4]]);
  const mac = await parseXlsxSpreadsheet(await workbook(true), signal);
  assert.equal(mac.sheets[0].cells.get("A2")?.value, "2026-01-01");
});

test("image input becomes bounded real JPEG pixels and active SVG is refused", async () => {
  const source = await sharp({ create: { width: 3000, height: 1500, channels: 4, background: "#ff000080" } }).png().toBuffer();
  const data = await prepareChatImage(source, signal);
  const metadata = await sharp(data).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 1568);
  assert.equal(metadata.height, 784);
  assert.equal(metadata.hasAlpha, false);
  await assert.rejects(prepareChatImage(encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), signal));
  await assert.rejects(prepareChatImage(encode("not an image"), signal));
});

// Isolated opt-in DB integration; never uses the application's DATABASE_URL.
test("reader access rejects missing, private, excluded, protected, trashed and incomplete sources before download", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 2 });
  const db = drizzle(client);
  const shared = globalThis as typeof globalThis & { oroleDatabase?: Database };
  const previous = shared.oroleDatabase;
  shared.oroleDatabase = db;
  const memberId = randomUUID();
  const otherId = randomUUID();
  const ctx: DriveContext = { userId: memberId, sessionId: randomUUID(), email: `${memberId}@${EMAIL_DOMAIN_WHITELIST[0]}` };
  const parentId = randomUUID();
  const fileId = randomUUID();
  const privateId = randomUUID();
  try {
    await db.insert(user).values([memberId, otherId].map((id) => ({ id, name: id, email: `${id}@${EMAIL_DOMAIN_WHITELIST[0]}`, emailVerified: true })));
    await db.insert(session).values({ id: ctx.sessionId, token: randomUUID(), userId: memberId, expiresAt: new Date(Date.now() + 600_000) });
    await db.insert(driveItems).values({ id: parentId, name: "Folder", kind: "folder", state: "complete", ownerId: memberId });
    await db.insert(driveItems).values([
      { id: fileId, parentId, name: "image.png", kind: "file", state: "complete", ownerId: memberId, size: 100, mimeType: "image/png", objectKey: `files/${fileId}/x`, etag: '"reader"' },
      { id: privateId, name: "other.csv", kind: "file", state: "complete", ownerId: otherId, size: 10, mimeType: "text/csv", objectKey: `files/${privateId}/x`, etag: '"private"' },
    ]);
    assert.equal((await requireChatFile(ctx, fileId)).id, fileId);
    await assert.rejects(requireChatFile(ctx, randomUUID()));
    await assert.rejects(requireChatFile(ctx, privateId));
    for (const change of [{ searchExcluded: true }, { passwordHash: "protected", passwordVersion: randomUUID() }, { trashedAt: new Date() }, { deletionStartedAt: new Date() }]) {
      await db.update(driveItems).set(change).where(eq(driveItems.id, parentId));
      await assert.rejects(requireChatFile(ctx, fileId));
      await db.update(driveItems).set({ searchExcluded: false, passwordHash: null, passwordVersion: null, trashedAt: null, deletionStartedAt: null }).where(eq(driveItems.id, parentId));
    }
    await db.update(driveItems).set({ state: "pending", etag: null }).where(eq(driveItems.id, fileId));
    await assert.rejects(requireChatFile(ctx, fileId));
    const context: ChatToolContext = {
      ctx, chatId: randomUUID(), assistantMessageId: randomUUID(), signal, attachments: [], contentSourceIds: () => [],
      cite: () => assert.fail("Unauthorized sources must not be cited"),
      run: async (_tool, _label, work) => (await work(randomUUID())).result,
      mentionedOwner: () => undefined,
    };
    const tools = createChatReaderTools(context);
    const options = { toolCallId: randomUUID(), messages: [], context: {} };
    await assert.rejects(async () => tools.read_document.execute!({ itemId: privateId }, options));
    await assert.rejects(async () => tools.read_spreadsheet.execute!({ itemId: privateId }, options));
    await assert.rejects(async () => tools.calculate_spreadsheet.execute!({ itemId: privateId, operation: "sum", column: "A" }, options));
    await assert.rejects(async () => tools.view_image.execute!({ itemId: privateId }, options));
    await assert.rejects(async () => tools.read_image.execute!({ itemId: privateId, task: "ocr" }, options));
  } finally {
    shared.oroleDatabase = previous;
    try { await db.delete(driveItems).where(inArray(driveItems.id, [fileId, privateId, parentId])); await db.delete(user).where(inArray(user.id, [memberId, otherId])); }
    finally { await client.end(); }
  }
});
