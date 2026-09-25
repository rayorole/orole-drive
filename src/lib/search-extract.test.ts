import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { extractBytes, SEARCH_IMAGE_MAX_BYTES, searchSource } from "./search-extract";

const signal = new AbortController().signal;
const encode = (text: string) => new TextEncoder().encode(text);

async function zip(files: Record<string, string>) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, text] of Object.entries(files)) await writer.add(name, new Uint8ArrayReader(encode(text)));
  return writer.close();
}

const rels = (links: [id: string, type: string, target: string][]) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const types = (overrides = "") => `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;

/** A one-page PDF per text, with a valid xref so PDF.js reads the text layer. */
function pdf(pages: string[]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  pages.forEach((text, index) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(body);
}

test("sources are chosen from metadata, with size limits per type", () => {
  const file = { kind: "file" as const, size: 10 };
  assert.deepEqual(searchSource({ ...file, name: "notes.md", mimeType: "text/markdown" }), { kind: "text", maxBytes: Infinity });
  assert.equal(searchSource({ ...file, name: "scan.pdf", mimeType: "application/pdf", size: 6 * 1_048_576 }).valueOf().hasOwnProperty("skip"), true);
  assert.deepEqual(searchSource({ ...file, name: "photo.jpg", mimeType: "image/jpeg", size: SEARCH_IMAGE_MAX_BYTES + 1 }), { skip: "too_large" });
  assert.deepEqual(searchSource({ ...file, name: "photo.bmp", mimeType: "image/bmp" }), { skip: "unsupported" });
  assert.deepEqual(searchSource({ ...file, name: "movie.mp4", mimeType: "video/mp4" }), { skip: "unsupported" });
  assert.deepEqual(searchSource({ ...file, name: "macro.docm", mimeType: "application/octet-stream" }), { skip: "unsupported" });
  assert.deepEqual(searchSource({ ...file, name: "empty.txt", mimeType: "text/plain", size: 0 }), { skip: "empty" });
  assert.deepEqual(searchSource({ kind: "folder", size: 0, name: "Docs", mimeType: null }), { skip: "unsupported" });
});

test("PDF text becomes one section per page", async () => {
  assert.deepEqual(await extractBytes("pdf", pdf(["Eerste pagina", "Second page"]), signal), {
    sections: [{ text: "Eerste pagina", location: "page 1" }, { text: "Second page", location: "page 2" }],
  });
  assert.deepEqual(await extractBytes("pdf", encode("not a pdf"), signal), { skip: "unsupported" });
});

test("docx body text is extracted through mammoth", async () => {
  const bytes = await zip({
    "[Content_Types].xml": types('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
    "_rels/.rels": rels([["rId1", "officeDocument", "word/document.xml"]]),
    "word/document.xml": '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Huurcontract Amsterdam</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Ingang &amp; einde</w:t></w:r></w:p></w:body></w:document>',
  });
  const result = await extractBytes("docx", bytes, signal);
  assert.ok("sections" in result);
  assert.match(result.sections[0].text, /Huurcontract Amsterdam\s+Ingang & einde/);
});

test("xlsx has one section per visible sheet with shared strings and cached values", async () => {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const bytes = await zip({
    "[Content_Types].xml": types(),
    "_rels/.rels": rels([["rId1", "officeDocument", "xl/workbook.xml"]]),
    "xl/workbook.xml": `<workbook ${ns}><sheets><sheet name="Budget &amp; plan" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": rels([["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "worksheet", "worksheets/sheet2.xml"], ["rId3", "sharedStrings", "sharedStrings.xml"]]),
    "xl/sharedStrings.xml": `<sst ${ns}><si><t>Boodschappen</t></si><si><r><t>Rich </t></r><r><t>text</t></r><rPh><t>ふりがな</t></rPh></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(1,2)</f><v>3</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>inline</t></is></c><c r="C2" t="b"><v>1</v></c></row><row r="999"><c r="A999" t="inlineStr"><is><t>beyond preview rows</t></is></c></row></sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>secret</t></is></c></row></sheetData></worksheet>`,
  });
  assert.deepEqual(await extractBytes("xlsx", bytes, signal), { sections: [{ text: "Boodschappen | 3\nRich text | inline | TRUE", location: "Budget & plan" }] });
});

test("pptx has one section per slide from text runs", async () => {
  const p = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const slide = (lines: string[]) => `<p:sld ${p}><p:cSld><p:spTree><p:sp><p:txBody>${lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const bytes = await zip({
    "[Content_Types].xml": types(),
    "_rels/.rels": rels([["rId1", "officeDocument", "ppt/presentation.xml"]]),
    "ppt/presentation.xml": `<p:presentation ${p}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels([["rId2", "slide", "slides/slide1.xml"], ["rId3", "slide", "slides/slide2.xml"]]),
    "ppt/slides/slide1.xml": slide(["Jaaroverzicht", "2026"]),
    "ppt/slides/slide2.xml": slide(["Vakantie"]),
  });
  assert.deepEqual(await extractBytes("pptx", bytes, signal), { sections: [{ text: "Jaaroverzicht\n2026", location: "slide 1" }, { text: "Vakantie", location: "slide 2" }] });
});

test("macro-enabled, DTD and corrupt Office files are skipped", async () => {
  const macro = await zip({ "[Content_Types].xml": types(), "_rels/.rels": rels([]), "word/vbaProject.bin": "x", "word/document.xml": "<w:document/>" });
  assert.deepEqual(await extractBytes("docx", macro, signal), { skip: "unsupported" });
  const dtd = await zip({ "[Content_Types].xml": '<!DOCTYPE x [<!ENTITY a "b">]><Types/>', "_rels/.rels": rels([]) });
  assert.deepEqual(await extractBytes("xlsx", dtd, signal), { skip: "unsupported" });
  assert.deepEqual(await extractBytes("pptx", encode("PK not really"), signal), { skip: "unsupported" });
});

test("images are re-encoded as bounded JPEG before captioning", async () => {
  const png = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#3366ff" } }).png().toBuffer();
  let sent: { mediaType: string; width?: number } | undefined;
  const result = await extractBytes("image", png, signal, async (image) => {
    sent = { mediaType: image.mediaType, width: (await sharp(image.data).metadata()).width };
    return "A plain blue banner. No visible text.";
  });
  assert.deepEqual(result, { sections: [{ text: "A plain blue banner. No visible text.", location: "caption" }] });
  assert.deepEqual(sent, { mediaType: "image/jpeg", width: 1568 });
  assert.deepEqual(await extractBytes("image", encode("not an image"), signal, async () => assert.fail("undecodable images are never sent")), { skip: "unsupported" });
  assert.deepEqual(await extractBytes("image", png, signal, async () => "  "), { skip: "empty" });
});
