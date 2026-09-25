import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { OFFICE_LIMITS, OfficePreviewError, officeRaster, officeRelationshipTarget, readOfficeArchive } from "./office-archive";
import type { OfficeKind } from "./file-preview";

export type OfficeSheet = { name: string; rows: string[][]; columns: number; clipped: boolean };
export type SlideRun = { text: string; bold: boolean; italic: boolean; size: number; color: string };
export type SlideParagraph = { runs: SlideRun[]; align: "left" | "center" | "right"; bullet: boolean };
export type SlideShape = { x: number; y: number; width: number; height: number; rotation: number; fill: string; stroke: string; ellipse: boolean; image?: string; alt?: string; paragraphs: SlideParagraph[] };
export type OfficeSlide = { shapes: SlideShape[]; background: string };
export type OfficeDocument = { kind: "docx"; html: string } | { kind: "xlsx"; sheets: OfficeSheet[] } | { kind: "pptx"; slides: OfficeSlide[]; width: number; height: number };

const elements = (node: Element | Document, name: string) => Array.from(node.getElementsByTagNameNS("*", name));
const first = (node: Element | Document | undefined, name: string) => node?.getElementsByTagNameNS("*", name)[0];
const child = (node: Element | undefined, name: string) => node && Array.from(node.children).find((element) => element.localName === name);
function number(value: string | null | undefined, fallback = 0) {
  const parsed = value == null || value === "" ? NaN : Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 1e10 ? parsed : fallback;
}
function relationshipId(node: Element, local = "id") {
  return Array.from(node.attributes).find((attribute) => attribute.localName === local && attribute.namespaceURI?.includes("relationships"))?.value ?? "";
}

/** XML is data only: no DTD/entity expansion, processing instructions, or arbitrary DOM insertion. */
export function parseOfficeXml(bytes: Uint8Array): Document {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const text = new TextDecoder(utf16, { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(text)) throw new OfficePreviewError("This document contains unsupported XML declarations. Download it to open it in Office.");
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.getElementsByTagName("parsererror").length) throw new OfficePreviewError("This document contains invalid XML. Download it to open it in Office.");
  const nodes = xml.getElementsByTagName("*");
  if (nodes.length > 80_000) throw new OfficePreviewError("This document is too complex to preview safely. Download it to open it in Office.");
  // Bound nesting before passing XML to recursive third-party document conversion.
  for (const node of nodes) {
    let depth = 0;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (++depth > 64) throw new OfficePreviewError("This document is too deeply nested to preview safely.");
    }
  }
  return xml;
}

class OfficePackage {
  readonly xmlParts = new Map<string, Document>();
  readonly images = new Map<string, string>();
  pixels = 0;
  constructor(readonly parts: Map<string, Uint8Array<ArrayBuffer>>, readonly signal: AbortSignal, readonly urls: Set<string>) {}
  xml(path: string): Document {
    this.signal.throwIfAborted();
    const existing = this.xmlParts.get(path);
    if (existing) return existing;
    const bytes = this.parts.get(path);
    if (!bytes) throw new OfficePreviewError("A required document part is missing. Download the file to open it in Office.");
    const parsed = parseOfficeXml(bytes);
    this.xmlParts.set(path, parsed);
    return parsed;
  }
  relationships(source: string): Map<string, { target: string; type: string }> {
    const slash = source.lastIndexOf("/");
    const path = `${source.slice(0, slash + 1)}_rels/${source.slice(slash + 1)}.rels`;
    const links = new Map<string, { target: string; type: string }>();
    if (!this.parts.has(path)) return links;
    for (const rel of elements(this.xml(path), "Relationship")) {
      const target = officeRelationshipTarget(source, rel.getAttribute("Target") ?? "", rel.getAttribute("TargetMode"));
      if (target && this.parts.has(target)) links.set(rel.getAttribute("Id") ?? "", { target, type: rel.getAttribute("Type") ?? "" });
    }
    return links;
  }
  image(path: string): string | undefined {
    this.signal.throwIfAborted();
    if (this.images.has(path)) return this.images.get(path);
    const bytes = this.parts.get(path);
    return bytes ? this.raster(bytes, path) : undefined;
  }
  raster(bytes: Uint8Array<ArrayBuffer>, key: string): string | undefined {
    if (this.images.has(key)) return this.images.get(key);
    const raster = officeRaster(bytes);
    if (!raster || this.images.size >= 100 || this.pixels + raster.pixels > 64_000_000) return undefined;
    this.pixels += raster.pixels;
    const url = URL.createObjectURL(new Blob([bytes], { type: raster.type }));
    this.urls.add(url);
    this.images.set(key, url);
    return url;
  }
}

async function word(pkg: OfficePackage): Promise<OfficeDocument> {
  // Repack only validated XML and safe raster parts. Mammoth never receives the original ZIP,
  // external relationships, macros, HTML altChunks, embedded packages, or unbounded compressed data.
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
  for (const [path, bytes] of pkg.parts) {
    pkg.signal.throwIfAborted();
    let data = bytes;
    if (/\.(?:xml|rels)$/i.test(path)) {
      const xml = pkg.xml(path);
      if (path.endsWith(".rels")) {
        const source = path === "_rels/.rels" ? "" : path.replace(/_rels\/([^/]+)\.rels$/, "$1");
        for (const rel of elements(xml, "Relationship")) {
          const target = officeRelationshipTarget(source, rel.getAttribute("Target") ?? "", rel.getAttribute("TargetMode"));
          if (!target || !pkg.parts.has(target) || !/\.(?:xml|png|jpe?g|gif)$/i.test(target)) rel.remove();
        }
      } else {
        // Removing a relationship alone leaves dangling references that Word converters may
        // dereference. Preserve hyperlink text, but remove linked/unsupported drawing content.
        for (const hyperlink of elements(xml, "hyperlink")) hyperlink.replaceWith(...Array.from(hyperlink.childNodes));
        const links = pkg.relationships(path);
        for (const image of [...elements(xml, "blip"), ...elements(xml, "imagedata")]) {
          const target = links.get(relationshipId(image, image.localName === "blip" ? "embed" : "id"))?.target;
          if (target && pkg.parts.has(target) && officeRaster(pkg.parts.get(target)!)) continue;
          let drawing = image;
          while (drawing.parentElement && !["drawing", "pict"].includes(drawing.localName)) drawing = drawing.parentElement;
          if (drawing !== xml.documentElement) drawing.remove();
          else image.remove();
        }
        for (const active of [...elements(xml, "altChunk"), ...elements(xml, "object")]) active.remove();
      }
      data = new TextEncoder().encode(new XMLSerializer().serializeToString(xml));
    } else if (!officeRaster(bytes)) continue;
    await writer.add(path, new Uint8ArrayReader(data), { signal: pkg.signal });
  }
  const safeZip = await writer.close();
  const [mammoth, { default: purifier }] = await Promise.all([import("mammoth"), import("dompurify")]);
  pkg.signal.throwIfAborted();
  let imageIndex = 0;
  const result = await mammoth.convertToHtml({ arrayBuffer: safeZip.buffer as ArrayBuffer }, {
    externalFileAccess: false,
    includeEmbeddedStyleMap: false,
    styleMap: ["p[style-name='Title'] => h1:fresh", "u => u", "strike => s"],
    convertImage: mammoth.images.imgElement(async (image) => {
      pkg.signal.throwIfAborted();
      const src = pkg.raster(new Uint8Array(await image.readAsArrayBuffer()), `word-${imageIndex++}`);
      return { src: src ?? "", alt: src ? "Embedded document image" : "Unsupported or oversized image omitted" };
    }),
  });
  pkg.signal.throwIfAborted();
  if (!purifier.isSupported) throw new OfficePreviewError("This browser cannot safely render Word previews. Download the document instead.");
  const html = purifier.sanitize(result.value, {
    ALLOWED_TAGS: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "sup", "sub", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "blockquote", "pre", "code", "img"],
    ALLOWED_ATTR: ["src", "alt", "colspan", "rowspan"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^blob:/,
  });
  return { kind: "docx", html };
}

function spreadsheet(pkg: OfficePackage): OfficeDocument {
  const workbook = pkg.xml("xl/workbook.xml");
  const links = pkg.relationships("xl/workbook.xml");
  const stringPath = Array.from(links.values()).find((link) => link.type.endsWith("/sharedStrings"))?.target;
  const strings = stringPath ? elements(pkg.xml(stringPath), "si").map((item) => elements(item, "t").map((text) => text.textContent ?? "").join("")) : [];
  const definitions = elements(workbook, "sheet").filter((sheet) => !["hidden", "veryHidden"].includes(sheet.getAttribute("state") ?? ""));
  if (definitions.length > OFFICE_LIMITS.sheets) throw new OfficePreviewError("Preview supports up to 40 visible worksheets. Download this workbook to view all sheets.");
  const sheets = definitions.map((definition): OfficeSheet => {
    pkg.signal.throwIfAborted();
    const path = links.get(relationshipId(definition))?.target;
    if (!path) throw new OfficePreviewError("A worksheet is missing or references an external document.");
    const xml = pkg.xml(path);
    const rows: string[][] = [];
    let columns = 1;
    let clipped = false;
    for (const cell of elements(xml, "c")) {
      const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(cell.getAttribute("r") ?? "");
      if (!match) continue;
      let column = 0;
      for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
      const row = Number(match[2]);
      if (row > OFFICE_LIMITS.rows || column > OFFICE_LIMITS.columns) { clipped = true; continue; }
      const type = cell.getAttribute("t");
      const value = first(cell, "v")?.textContent ?? "";
      // Formulas are never evaluated. Only the workbook's last saved cached result is shown.
      const text = type === "inlineStr" ? elements(cell, "t").map((part) => part.textContent ?? "").join("") : type === "s" ? strings[number(value, -1)] ?? "" : type === "b" ? value === "1" ? "TRUE" : "FALSE" : value;
      rows[row - 1] ??= [];
      rows[row - 1][column - 1] = text || (first(cell, "f") ? "[No cached value]" : "");
      columns = Math.max(columns, column);
    }
    return { name: definition.getAttribute("name") ?? "Sheet", rows: Array.from({ length: rows.length }, (_, index) => rows[index] ?? []), columns, clipped };
  });
  if (!sheets.length) throw new OfficePreviewError("This workbook has no visible worksheets.");
  return { kind: "xlsx", sheets };
}

function color(node: Element | undefined, theme: Record<string, string>, fallback = "transparent"): string {
  const rgb = first(node, "srgbClr")?.getAttribute("val");
  if (rgb && /^[\da-f]{6}$/i.test(rgb)) return `#${rgb}`;
  const system = first(node, "sysClr")?.getAttribute("lastClr");
  if (system && /^[\da-f]{6}$/i.test(system)) return `#${system}`;
  const scheme = first(node, "schemeClr")?.getAttribute("val") ?? "";
  return Object.hasOwn(theme, scheme) ? theme[scheme] : fallback;
}

async function presentation(pkg: OfficePackage): Promise<OfficeDocument> {
  const main = pkg.xml("ppt/presentation.xml");
  const size = first(main, "sldSz");
  const width = Math.max(1, number(size?.getAttribute("cx"), 12192000));
  const height = Math.max(1, number(size?.getAttribute("cy"), 6858000));
  const slideIds = elements(main, "sldId");
  if (!slideIds.length || slideIds.length > OFFICE_LIMITS.slides) throw new OfficePreviewError("Preview supports presentations with 1–100 slides. Download this file to view it in PowerPoint.");
  const links = pkg.relationships("ppt/presentation.xml");
  const slides: OfficeSlide[] = [];
  for (const id of slideIds) {
    pkg.signal.throwIfAborted();
    const path = links.get(relationshipId(id))?.target;
    if (!path) throw new OfficePreviewError("A slide is missing or references an external document.");
    const xml = pkg.xml(path);
    const slideLinks = pkg.relationships(path);
    const layoutPath = Array.from(slideLinks.values()).find((link) => link.type.endsWith("/slideLayout"))?.target;
    const layout = layoutPath ? pkg.xml(layoutPath) : undefined;
    const layoutLinks = layoutPath ? pkg.relationships(layoutPath) : new Map<string, { target: string; type: string }>();
    const masterPath = Array.from(layoutLinks.values()).find((link) => link.type.endsWith("/slideMaster"))?.target;
    const master = masterPath ? pkg.xml(masterPath) : undefined;
    const masterLinks = masterPath ? pkg.relationships(masterPath) : new Map<string, { target: string; type: string }>();
    const themePath = Array.from(masterLinks.values()).find((link) => link.type.endsWith("/theme"))?.target;
    const theme: Record<string, string> = { dk1: "#000000", lt1: "#ffffff", tx1: "#000000", bg1: "#ffffff", accent1: "#4472c4" };
    if (themePath) for (const entry of first(pkg.xml(themePath), "clrScheme")?.children ?? []) theme[entry.localName] = color(entry, {}, "#000000");
    theme.tx1 = theme.dk1; theme.bg1 = theme.lt1; theme.tx2 = theme.dk2; theme.bg2 = theme.lt2;
    const shapes: SlideShape[] = [];
    const placeholder = (shape: Element, document: Document | undefined) => {
      const ph = first(shape, "ph");
      if (!ph || !document) return undefined;
      return elements(document, "sp").find((candidate) => {
        const other = first(candidate, "ph");
        return other && (ph.getAttribute("idx") ?? "0") === (other.getAttribute("idx") ?? "0") && (ph.getAttribute("type") ?? "body") === (other.getAttribute("type") ?? "body");
      });
    };
    const visit = (tree: Element | undefined, source: string, sx = 1, sy = 1, dx = 0, dy = 0, decoration = false) => {
      if (!tree) return;
      for (const shape of tree.children) {
        if (!["sp", "pic", "grpSp", "graphicFrame", "cxnSp"].includes(shape.localName)) continue;
        if (decoration && first(shape, "ph")) continue;
        if (shapes.length >= 500) throw new OfficePreviewError("A slide has more than 500 objects and is too complex to preview safely.");
        const inherited = placeholder(shape, layout) ?? placeholder(shape, master);
        const properties = child(shape, "spPr") ?? child(shape, "grpSpPr");
        const transform = first(properties, "xfrm") ?? child(shape, "xfrm") ?? first(inherited, "xfrm");
        const offset = child(transform, "off");
        const extent = child(transform, "ext");
        const x = number(offset?.getAttribute("x"));
        const y = number(offset?.getAttribute("y"));
        const cx = number(extent?.getAttribute("cx"), width * 0.8);
        const cy = number(extent?.getAttribute("cy"), height * 0.2);
        if (shape.localName === "grpSp") {
          const origin = child(transform, "chOff");
          const space = child(transform, "chExt");
          const gx = cx / Math.max(1, number(space?.getAttribute("cx"), cx));
          const gy = cy / Math.max(1, number(space?.getAttribute("cy"), cy));
          visit(shape, source, sx * gx, sy * gy, dx + sx * (x - number(origin?.getAttribute("x")) * gx), dy + sy * (y - number(origin?.getAttribute("y")) * gy), decoration);
          continue;
        }
        const paragraphs = elements(shape, "p").map((paragraph): SlideParagraph => {
          const props = child(paragraph, "pPr");
          const align = props?.getAttribute("algn");
          const defaultRun = child(props, "defRPr");
          const runs: SlideRun[] = [];
          for (const run of paragraph.children) {
            if (run.localName === "br") { runs.push({ text: "\n", bold: false, italic: false, size: 18, color: theme.tx1 }); continue; }
            if (run.localName !== "r" && run.localName !== "fld") continue;
            const rp = child(run, "rPr") ?? defaultRun;
            runs.push({ text: first(run, "t")?.textContent ?? "", bold: rp?.getAttribute("b") === "1", italic: rp?.getAttribute("i") === "1", size: Math.max(6, Math.min(144, number(rp?.getAttribute("sz"), 1800) / 100)), color: color(child(rp, "solidFill"), theme, theme.tx1) });
          }
          return { runs, align: align === "ctr" ? "center" : align === "r" ? "right" : "left", bullet: !!child(props, "buChar") };
        });
        const blip = first(shape, "blip");
        const imagePath = blip ? pkg.relationships(source).get(relationshipId(blip, "embed"))?.target : undefined;
        shapes.push({ x: dx + x * sx, y: dy + y * sy, width: Math.max(1, cx * sx), height: Math.max(1, cy * sy), rotation: number(transform?.getAttribute("rot")) / 60000, fill: color(child(properties, "solidFill"), theme), stroke: color(child(child(properties, "ln"), "solidFill"), theme), ellipse: first(properties, "prstGeom")?.getAttribute("prst") === "ellipse", image: imagePath ? pkg.image(imagePath) : undefined, alt: first(shape, "cNvPr")?.getAttribute("descr") ?? "Embedded slide image", paragraphs });
      }
    };
    if (masterPath && xml.documentElement.getAttribute("showMasterSp") !== "0") visit(first(master, "spTree"), masterPath, 1, 1, 0, 0, true);
    if (layoutPath) visit(first(layout, "spTree"), layoutPath, 1, 1, 0, 0, true);
    visit(first(xml, "spTree"), path);
    const background = first(xml, "bgPr") ?? first(layout, "bgPr") ?? first(master, "bgPr");
    slides.push({ shapes, background: color(child(background, "solidFill"), theme, "#ffffff") });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { kind: "pptx", slides, width, height };
}

/** Caller owns every object URL and revokes them on failure, replacement and unmount. */
export async function loadOfficeDocument(bytes: Uint8Array, kind: OfficeKind, signal: AbortSignal, urls: Set<string>): Promise<OfficeDocument> {
  const pkg = new OfficePackage(await readOfficeArchive(bytes, signal), signal, urls);
  for (const [path] of pkg.parts) {
    if (/vbaProject|activeX|macrosheets/i.test(path)) throw new OfficePreviewError("Macro-enabled Office files are download-only.");
    if (/\.(?:xml|rels)$/i.test(path)) pkg.xml(path);
  }
  if (elements(pkg.xml("[Content_Types].xml"), "Override").some((type) => /macroEnabled/i.test(type.getAttribute("ContentType") ?? ""))) throw new OfficePreviewError("Macro-enabled Office files are download-only.");
  signal.throwIfAborted();
  return kind === "docx" ? word(pkg) : kind === "xlsx" ? spreadsheet(pkg) : presentation(pkg);
}
