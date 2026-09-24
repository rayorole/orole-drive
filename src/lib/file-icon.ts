import type { DriveItem } from "@/lib/drive-types";

const extensionIcons: Record<string, true> = {
  aep: true, ai: true, avi: true, css: true, csv: true, dmg: true, doc: true, docx: true,
  eps: true, exe: true, fig: true, gif: true, html: true, img: true, indd: true, java: true,
  jpeg: true, jpg: true, js: true, json: true, mkv: true, mp3: true, mp4: true, mpeg: true,
  pdf: true, png: true, ppt: true, pptx: true, psd: true, rar: true, rss: true, sql: true,
  svg: true, tiff: true, txt: true, wav: true, webp: true, xls: true, xlsx: true, xml: true, zip: true,
};

const extensionAliases: Record<string, string> = {
  "7z": "zip", gz: "zip", gzip: "zip", bz: "zip", bz2: "zip", xz: "zip", zst: "zip",
  z: "zip", tar: "zip", tgz: "zip", tbz: "zip", tbz2: "zip", txz: "zip", tzst: "zip", cab: "zip",
  htm: "html", mjs: "js", cjs: "js", tif: "tiff", mpg: "mpeg",
  jsx: "code", ts: "code", tsx: "code", py: "code", rb: "code", go: "code", rs: "code",
  c: "code", h: "code", cpp: "code", cs: "code", php: "code", sh: "code", yaml: "code", yml: "code",
  md: "document", rtf: "document", odt: "document", pages: "document",
  ods: "spreadsheets", numbers: "spreadsheets", odp: "ppt", key: "ppt",
  heic: "image", heif: "image", avif: "image", bmp: "image", ico: "image",
  flac: "audio", aac: "audio", m4a: "audio", ogg: "audio", opus: "audio",
  mov: "video", webm: "video", m4v: "video", wmv: "video",
};

const mimeIcons: Record<string, string> = {
  "application/pdf": "pdf", "application/json": "json", "text/json": "json",
  "application/ld+json": "json", "application/javascript": "js", "text/javascript": "js",
  "application/xml": "xml", "text/xml": "xml", "application/rss+xml": "rss",
  "text/html": "html", "text/css": "css", "text/csv": "csv", "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "document",
  "application/vnd.oasis.opendocument.spreadsheet": "spreadsheets",
  "application/vnd.oasis.opendocument.presentation": "ppt",
  "application/rtf": "document", "application/sql": "sql",
  "application/vnd.rar": "rar", "application/x-rar-compressed": "rar",
};

export function fileIconName(item: Pick<DriveItem, "name" | "kind" | "mimeType">): string {
  if (item.kind === "folder") return "folder";

  const dot = item.name.lastIndexOf(".");
  const extension = dot > 0 ? item.name.slice(dot + 1).toLowerCase() : "";
  if (Object.hasOwn(extensionIcons, extension)) return extension;
  if (Object.hasOwn(extensionAliases, extension)) return extensionAliases[extension];

  const mime = item.mimeType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (Object.hasOwn(mimeIcons, mime)) return mimeIcons[mime];
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (/zip|gzip|compressed|archive|x-tar|zstd/.test(mime)) return "zip";
  if (mime.endsWith("+json")) return "json";
  if (mime.endsWith("+xml")) return "xml";
  if (/javascript|ecmascript|x-python|x-shellscript|x-sh|x-java|x-csrc|x-c\+\+src/.test(mime)) return "code";
  if (mime.startsWith("text/")) return "document";
  return "empty";
}
