import assert from "node:assert/strict";
import test from "node:test";
import { fileRiskSignals, riskLevel } from "./file-risk-signals";

test("a program hiding behind a document name is flagged as disguised", () => {
  assert.deepEqual(fileRiskSignals("invoice.pdf.exe", "application/x-msdownload").sort(), ["double-extension", "executable"]);
  assert.ok(fileRiskSignals("Holiday photos.JPG.scr", "application/octet-stream").includes("double-extension"));
  assert.ok(fileRiskSignals("report.docx.iso", null).includes("double-extension"));
});

test("names that hide their real extension are flagged", () => {
  // U+202E reverses the display, so this renders as "invoiceexe.pdf" but is an .exe.
  const reversed = fileRiskSignals("invoice\u202efdp.exe", "application/octet-stream");
  assert.ok(reversed.includes("hidden-extension"));
  assert.ok(reversed.includes("executable"));
  assert.ok(fileRiskSignals("photo.jpg            .exe", null).includes("hidden-extension"));
});

test("declared type must agree with the name", () => {
  assert.ok(fileRiskSignals("contract.pdf", "application/x-msdownload").includes("mime-mismatch"));
  assert.ok(fileRiskSignals("song.mp3", "application/pdf").includes("mime-mismatch"));
  assert.ok(fileRiskSignals("setup.exe", "image/png").includes("mime-mismatch"));
});

test("ordinary files raise nothing, and a lone dotted name is not a double extension", () => {
  assert.deepEqual(fileRiskSignals("Budget 2026.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), []);
  assert.deepEqual(fileRiskSignals("IMG_2041.jpeg", "image/jpeg"), []);
  assert.deepEqual(fileRiskSignals("v1.2.release-notes.txt", "text/plain"), []);
  assert.deepEqual(fileRiskSignals("backup.tar.gz", "application/gzip"), ["archive"]);
  assert.deepEqual(fileRiskSignals("budget.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"), ["macro-document"]);
});

test("local disguise evidence outranks a reassuring model score", () => {
  assert.equal(riskLevel(["double-extension", "executable"], 0.1, 0.05), "high");
  assert.equal(riskLevel(["hidden-extension"], null, null), "high");
});

test("the model decides between the remaining levels, and runnable files are never low", () => {
  assert.equal(riskLevel([], 2.4, 0.1), "high");
  assert.equal(riskLevel([], 0.2, 0.9), "high");
  assert.equal(riskLevel([], 1.5, 0.1), "medium");
  assert.equal(riskLevel(["executable"], 0.1, 0.02), "medium");
  assert.equal(riskLevel(["archive"], 0.4, 0.05), "low");
  assert.equal(riskLevel([], null, null), "low");
});
