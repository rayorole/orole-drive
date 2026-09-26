import "server-only";

import { DriveError } from "@/lib/drive-errors";
import { OFFICE_LIMITS, OfficePreviewError } from "@/lib/office-archive";
import { attribute, decodeXml, elements, readSafeOfficeParts, relationships, textRuns, xmlText } from "@/lib/office-text";

export const SPREADSHEET_MAX_CELLS = 100_000;
const DECIMAL_TEN = BigInt(10);
const AVERAGE_FACTOR = BigInt("100000000000000000000");
export type SpreadsheetCell = { value: string | number | boolean | null; type: "text" | "number" | "date" | "boolean" | "error" | "blank"; formula: boolean };
export type SpreadsheetSheet = { name: string; cells: Map<string, SpreadsheetCell>; totalRows: number; totalColumns: number };
export type Spreadsheet = { sheets: SpreadsheetSheet[] };
export type CellRange = { startRow: number; endRow: number; startColumn: number; endColumn: number };
export type SpreadsheetOperation = "sum" | "count" | "average" | "min" | "max";

export function columnName(column: number): string {
  let name = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}

function cellAddress(address: string): { row: number; column: number } {
  const match = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/i.exec(address);
  if (!match) throw new DriveError("Use an A1 cell range, for example A1:D100.");
  let column = 0;
  for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16_384 || row > 1_048_576) throw new DriveError("That cell is outside the worksheet bounds.");
  return { row, column };
}

export function spreadsheetRange(sheet: SpreadsheetSheet, range?: string, maxCells = SPREADSHEET_MAX_CELLS): CellRange {
  const pieces = range?.trim().split(":");
  if (pieces && (pieces.length > 2 || !pieces[0])) throw new DriveError("Use an A1 cell range.");
  const start = pieces ? cellAddress(pieces[0]) : { row: 1, column: 1 };
  const end = pieces ? cellAddress(pieces[1] ?? pieces[0]) : { row: Math.max(1, sheet.totalRows), column: Math.max(1, sheet.totalColumns) };
  if (end.row < start.row || end.column < start.column) throw new DriveError("The range end must follow its start.");
  if ((end.row - start.row + 1) * (end.column - start.column + 1) > maxCells) throw new DriveError(`Request a smaller range (at most ${maxCells.toLocaleString("en")} cells). No partial calculation was made.`);
  return { startRow: start.row, endRow: end.row, startColumn: start.column, endColumn: end.column };
}

function numericText(value: string): number | null {
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** ISO dates only: ambiguous locale dates are deliberately not guessed. */
export function spreadsheetMonth(value: string | number | boolean | null): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})(?:-(\d{2})(?:T.*)?)?$/.exec(value.trim());
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return null;
  if (match[3]) {
    const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== `${match[1]}-${match[2]}-${match[3]}`) return null;
  }
  return `${match[1]}-${match[2]}`;
}

function excelDate(serial: number, date1904: boolean): string | null {
  if (serial < 0 || serial > 2_958_465 || (!date1904 && Math.floor(serial) === 60)) return null;
  const day = Math.floor(serial);
  const base = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
  const date = new Date(base + (day - (!date1904 && day > 60 ? 1 : 0)) * 86_400_000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/** RFC 4180-style quoted fields, including escaped quotes and embedded newlines. No formulas execute. */
export function parseDelimitedSpreadsheet(text: string, delimiter: "," | "\t" | ";" = ","): Spreadsheet {
  const sheet: SpreadsheetSheet = { name: "Sheet1", cells: new Map(), totalRows: 0, totalColumns: 0 };
  let row = 1;
  let column = 1;
  let value = "";
  let quoted = false;
  let closedQuote = false;
  let count = 0;
  const store = () => {
    if (++count > SPREADSHEET_MAX_CELLS) throw new DriveError("This spreadsheet exceeds the 100,000-cell reading limit.");
    const number = numericText(value);
    if (value !== "") sheet.cells.set(`${columnName(column)}${row}`, { value: number ?? value, type: number === null ? "text" : "number", formula: false });
    sheet.totalRows = row;
    sheet.totalColumns = Math.max(sheet.totalColumns, column);
    value = "";
    closedQuote = false;
  };
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else value += char;
      continue;
    }
    if (char === delimiter) { store(); column++; }
    else if (char === "\n" || char === "\r") { store(); row++; column = 1; if (char === "\r" && source[index + 1] === "\n") index++; }
    else if (char === '"' && value === "" && !closedQuote) quoted = true;
    else {
      if (closedQuote || char === '"') throw new DriveError("The delimited file has invalid quoting.");
      value += char;
    }
  }
  if (quoted) throw new DriveError("The delimited file has an unclosed quoted field.");
  if (value || column > 1 || closedQuote || (source.length > 0 && !/[\r\n]$/.test(source))) store();
  return { sheets: [sheet] };
}

export async function parseXlsxSpreadsheet(bytes: Uint8Array, signal: AbortSignal): Promise<Spreadsheet> {
  const parts = await readSafeOfficeParts(bytes, signal);
  const workbook = xmlText(parts, "xl/workbook.xml");
  const links = relationships(parts, "xl/workbook.xml");
  const stringsPath = Array.from(links.values()).find((link) => link.type.endsWith("/sharedStrings"))?.target;
  const strings = stringsPath ? elements(xmlText(parts, stringsPath), "si").map((item) => textRuns(item.body.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, ""))) : [];
  const stylesPath = Array.from(links.values()).find((link) => link.type.endsWith("/styles"))?.target;
  const styles = stylesPath ? xmlText(parts, stylesPath) : "";
  const formats = new Map(elements(styles, "numFmt").map((format) => [Number(attribute(format.attributes, "numFmtId")), decodeXml(attribute(format.attributes, "formatCode") ?? "")]));
  const dateStyles = elements(elements(styles, "cellXfs")[0]?.body ?? "", "xf").map((style) => {
    const id = Number(attribute(style.attributes, "numFmtId"));
    const format = (formats.get(id) ?? "").replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
    return (id >= 14 && id <= 17) || id === 22 || (id >= 27 && id <= 36) || (id >= 50 && id <= 58) || /[yd]/i.test(format);
  });
  const date1904 = ["1", "true"].includes(attribute(elements(workbook, "workbookPr")[0]?.attributes ?? "", "date1904") ?? "");
  const definitions = elements(workbook, "sheet").filter((sheet) => !["hidden", "veryHidden"].includes(attribute(sheet.attributes, "state") ?? ""));
  if (definitions.length > OFFICE_LIMITS.sheets) throw new OfficePreviewError("This workbook has too many visible worksheets.");
  let count = 0;
  const sheets = definitions.map((definition): SpreadsheetSheet => {
    signal.throwIfAborted();
    const path = links.get(attribute(definition.attributes, "id", true) ?? "")?.target;
    if (!path) throw new OfficePreviewError("A worksheet is missing.");
    const sheet: SpreadsheetSheet = { name: decodeXml(attribute(definition.attributes, "name") ?? "Sheet"), cells: new Map(), totalRows: 0, totalColumns: 0 };
    for (const cell of elements(xmlText(parts, path), "c")) {
      if (++count > SPREADSHEET_MAX_CELLS) throw new DriveError("This workbook exceeds the 100,000-cell reading limit.");
      const address = attribute(cell.attributes, "r") ?? "";
      const { row, column } = cellAddress(address);
      const key = `${columnName(column)}${row}`;
      if (sheet.cells.has(key)) throw new OfficePreviewError("This worksheet contains duplicate cell addresses.");
      sheet.totalRows = Math.max(sheet.totalRows, row);
      sheet.totalColumns = Math.max(sheet.totalColumns, column);
      const type = attribute(cell.attributes, "t");
      const raw = decodeXml(elements(cell.body, "v")[0]?.body ?? "");
      const formula = elements(cell.body, "f").length > 0;
      let value: SpreadsheetCell["value"] = raw || null;
      let cellType: SpreadsheetCell["type"] = raw ? "text" : "blank";
      if (type === "inlineStr") { value = textRuns(cell.body); cellType = "text"; }
      else if (type === "s") { value = strings[Number(raw)] ?? null; cellType = value === null ? "error" : "text"; }
      else if (type === "b") { value = raw === "1"; cellType = "boolean"; }
      else if (type === "e") cellType = "error";
      else if (type === "d") cellType = spreadsheetMonth(raw) ? "date" : "error";
      else if ((!type || type === "n") && raw) {
        const number = numericText(raw);
        if (number !== null && dateStyles[Number(attribute(cell.attributes, "s") ?? 0)]) {
          value = excelDate(number, date1904);
          cellType = value === null ? "error" : "date";
        } else { value = number; cellType = number === null ? "error" : "number"; }
      }
      sheet.cells.set(key, { value, type: cellType, formula });
    }
    return sheet;
  });
  if (!sheets.length) throw new DriveError("This workbook has no visible worksheets.");
  return { sheets };
}

export function selectSpreadsheetSheet(workbook: Spreadsheet, name?: string): SpreadsheetSheet {
  const sheet = name ? workbook.sheets.find((candidate) => candidate.name === name) : workbook.sheets[0];
  if (!sheet) throw new DriveError("That visible worksheet does not exist. Read the workbook to see its sheet names.");
  return sheet;
}

export function readSpreadsheetRange(sheet: SpreadsheetSheet, options: { range?: string; startRow?: number; maxRows?: number } = {}) {
  const defaultRange = `A1:${columnName(Math.max(1, Math.min(30, sheet.totalColumns)))}${Math.max(1, sheet.totalRows)}`;
  const range = spreadsheetRange(sheet, options.range ?? defaultRange, Number.MAX_SAFE_INTEGER);
  const startRow = options.startRow ?? range.startRow;
  const maxRows = options.maxRows ?? 50;
  const width = range.endColumn - range.startColumn + 1;
  if (!Number.isInteger(startRow) || startRow < range.startRow || startRow > range.endRow || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100) throw new DriveError("Request 1–100 rows within the selected range.");
  if (width > 30) throw new DriveError("Read at most 30 columns at a time using an A1 range.");
  const requestedEnd = Math.min(range.endRow, startRow + maxRows - 1, startRow + Math.floor(2_000 / width) - 1);
  const rows: (string | number | null)[][] = [];
  const clippedCells: string[] = [];
  let cachedFormulaCells = 0;
  let missingFormulaCells = 0;
  let characters = 0;
  let endRow = startRow;
  for (let row = startRow; row <= requestedEnd; row++) {
    const values: (string | number | null)[] = [row];
    const clipped: string[] = [];
    let cached = 0;
    let missing = 0;
    for (let column = range.startColumn; column <= range.endColumn; column++) {
      const address = `${columnName(column)}${row}`;
      const cell = sheet.cells.get(address);
      if (cell?.formula) { if (cell.value === null) missing++; else cached++; }
      const value = typeof cell?.value === "boolean" ? String(cell.value) : cell?.value ?? null;
      if (typeof value === "string" && value.length > 500) clipped.push(address);
      values.push(typeof value === "string" ? value.slice(0, 500) : value);
    }
    const rowCharacters = values.reduce<number>((sum, value) => sum + String(value ?? "").length, 0);
    if (rows.length && characters + rowCharacters > 16_000) break;
    characters += rowCharacters;
    cachedFormulaCells += cached;
    missingFormulaCells += missing;
    clippedCells.push(...clipped);
    rows.push(values);
    endRow = row;
  }
  const nextCursor = endRow < range.endRow ? { startRow: endRow + 1 } : null;
  return {
    sheet: sheet.name, range: `${columnName(range.startColumn)}${startRow}:${columnName(range.endColumn)}${endRow}`,
    totalRows: sheet.totalRows, totalColumns: sheet.totalColumns,
    columns: ["Row", ...Array.from({ length: width }, (_, index) => columnName(range.startColumn + index))], rows,
    truncated: nextCursor !== null || clippedCells.length > 0 || (!options.range && sheet.totalColumns > 30),
    nextCursor, clippedCells, cachedFormulaCells, missingFormulaCells,
    additionalColumns: range.endColumn < sheet.totalColumns ? `${columnName(range.endColumn + 1)}:${columnName(sheet.totalColumns)}` : null,
  };
}

function resolveColumn(sheet: SpreadsheetSheet, name: string, headerRow: number | null): number {
  // Explicit uppercase letters address cells; other names first match the exact header.
  if (/^[A-Z]{1,3}$/.test(name)) return cellAddress(`${name}1`).column;
  const matches: number[] = [];
  if (headerRow !== null) for (let column = 1; column <= sheet.totalColumns; column++) {
    if (String(sheet.cells.get(`${columnName(column)}${headerRow}`)?.value ?? "").trim() === name) matches.push(column);
  }
  if (matches.length === 1) return matches[0];
  if (!matches.length && /^[a-z]{1,3}$/.test(name)) return cellAddress(`${name}1`).column;
  throw new DriveError("Choose an unambiguous uppercase column letter or an exact header name.");
}

type Aggregate = { count: number; blank: number; nonNumeric: number; sum: bigint; scale: number; min: number | null; max: number | null };
export function calculateSpreadsheet(sheet: SpreadsheetSheet, options: {
  operation: SpreadsheetOperation; column: string; range?: string; headerRow?: number | null;
  groupBy?: { column: string; period?: "value" | "month" }; groupOffset?: number;
}) {
  const range = spreadsheetRange(sheet, options.range);
  const headerRow = options.headerRow === undefined ? 1 : options.headerRow;
  if (headerRow !== null && (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 1_048_576)) throw new DriveError("Choose a valid header row, or null for no headers.");
  const column = resolveColumn(sheet, options.column, headerRow);
  const groupColumn = options.groupBy ? resolveColumn(sheet, options.groupBy.column, headerRow) : null;
  if ([column, ...(groupColumn === null ? [] : [groupColumn])].some((value) => value < range.startColumn || value > range.endColumn)) throw new DriveError("The value and grouping columns must be inside the requested range.");
  const groups = new Map<string, { label: string | number | boolean | null; aggregate: Aggregate }>();
  let invalidGroupRows = 0;
  let cachedFormulaCells = 0;
  let missingFormulaCells = 0;
  let rowsProcessed = 0;
  for (let row = range.startRow; row <= range.endRow; row++) {
    if (row === headerRow) continue;
    rowsProcessed++;
    const cell = sheet.cells.get(`${columnName(column)}${row}`);
    const group = groupColumn === null ? null : sheet.cells.get(`${columnName(groupColumn)}${row}`);
    let label = group?.value ?? null;
    if (options.groupBy?.period === "month") {
      label = spreadsheetMonth(label);
      if (label === null) { invalidGroupRows++; continue; }
    }
    if (group?.type === "error") { invalidGroupRows++; continue; }
    if (typeof label === "string" && label.length > 1_000) throw new DriveError("A grouping label exceeds the 1,000-character safe result limit. Choose a different grouping column.");
    const key = JSON.stringify([typeof label, label]);
    let entry = groups.get(key);
    if (!entry) {
      entry = { label, aggregate: { count: 0, blank: 0, nonNumeric: 0, sum: BigInt(0), scale: 0, min: null, max: null } };
      groups.set(key, entry);
    }
    const aggregate = entry.aggregate;
    if (cell?.formula) { if (cell.value === null) missingFormulaCells++; else cachedFormulaCells++; }
    if (cell?.type === "number" && typeof cell.value === "number") {
      const number = cell.value;
      if (options.operation === "sum" || options.operation === "average") {
        // Decimal accumulation keeps currency totals like 10.10 + 20.20 at 30.3, not binary rounding tails.
        const [mantissa, exponentText] = number.toString().split("e");
        const decimals = mantissa.includes(".") ? mantissa.length - mantissa.indexOf(".") - 1 : 0;
        const exponent = Number(exponentText ?? 0) - decimals;
        const scale = Math.max(0, -exponent);
        const coefficient = BigInt(mantissa.replace(".", "")) * DECIMAL_TEN ** BigInt(Math.max(0, exponent));
        if (scale > aggregate.scale) {
          aggregate.sum *= DECIMAL_TEN ** BigInt(scale - aggregate.scale);
          aggregate.scale = scale;
        }
        aggregate.sum += coefficient * DECIMAL_TEN ** BigInt(aggregate.scale - scale);
      }
      aggregate.count++;
      aggregate.min = aggregate.min === null ? number : Math.min(aggregate.min, number);
      aggregate.max = aggregate.max === null ? number : Math.max(aggregate.max, number);
    } else if (cell?.type === "error" || cell?.formula || (cell?.value !== null && cell?.value !== undefined && cell.value !== "")) aggregate.nonNumeric++;
    else aggregate.blank++;
  }
  if (!groups.size && !options.groupBy) groups.set("all", { label: null, aggregate: { count: 0, blank: 0, nonNumeric: 0, sum: BigInt(0), scale: 0, min: null, max: null } });
  const results = Array.from(groups.values(), ({ label, aggregate }) => {
    const value = options.operation === "count" ? aggregate.count
      : options.operation === "sum" ? Number(`${aggregate.sum}e-${aggregate.scale}`)
      : options.operation === "average" ? (aggregate.count ? Number(`${aggregate.sum * AVERAGE_FACTOR / BigInt(aggregate.count)}e-${aggregate.scale + 20}`) : null)
      : aggregate[options.operation];
    if (value !== null && !Number.isFinite(value)) throw new DriveError("The calculation exceeds finite numeric precision. No total was returned.");
    return { group: typeof label === "boolean" ? String(label) : label, value, numericCells: aggregate.count, blankCells: aggregate.blank, nonNumericCells: aggregate.nonNumeric };
  });
  results.sort((a, b) => String(a.group ?? "").localeCompare(String(b.group ?? ""), "en"));
  const offset = options.groupOffset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > results.length) throw new DriveError("The group cursor is outside the result.");
  let end = offset;
  let characters = 0;
  while (end < results.length && end - offset < 200) {
    const size = String(results[end].group ?? "").length + 100;
    if (end > offset && characters + size > 16_000) break;
    characters += size;
    end++;
  }
  return {
    sheet: sheet.name, operation: options.operation, column: columnName(column), range: `${columnName(range.startColumn)}${range.startRow}:${columnName(range.endColumn)}${range.endRow}`,
    rowsProcessed, invalidGroupRows, cachedFormulaCells, missingFormulaCells,
    results: results.slice(offset, end), totalGroups: results.length, truncated: end < results.length,
    nextCursor: end < results.length ? { groupOffset: end } : null,
    semantics: "COUNT counts numeric cells. Blank, text, boolean, error and date cells are excluded from numeric arithmetic. Formulas use only saved cached values; missing caches are not calculated. Month groups accept date-formatted Excel cells or unambiguous YYYY-MM[-DD] text. Parsed finite numbers are accumulated in decimal with a single final numeric conversion; averages use 20 additional decimal places.",
  };
}
