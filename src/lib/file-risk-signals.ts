/**
 * Facts about a file's name and declared type that make it worth scanning. They are computed
 * locally, shown to people as reasons, and given to the risk model as evidence.
 */
export type FileRiskSignal =
  | "executable"
  | "script"
  | "macro-document"
  | "disk-image"
  | "archive"
  | "double-extension"
  | "hidden-extension"
  | "mime-mismatch"
  | "no-extension";

const EXECUTABLE = new Set(["exe", "msi", "com", "scr", "pif", "cpl", "dll", "sys", "app", "apk", "ipa", "deb", "rpm", "jar", "elf", "bin", "run", "appimage", "pkg", "mpkg", "lnk", "msix", "appx", "gadget", "reg"]);
const SCRIPT = new Set(["bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "sh", "bash", "zsh", "command", "py", "pyw", "rb", "pl", "php", "applescript", "scpt"]);
const MACRO = new Set(["docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "sldm"]);
const DISK_IMAGE = new Set(["iso", "img", "dmg", "vhd", "vhdx"]);
const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "cab", "arj", "lzh", "ace"]);
// Extensions people trust at a glance; seeing one right before an executable one is the classic lure.
const DECOY = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "jpg", "jpeg", "png", "gif", "webp", "heic", "mp3", "mp4", "mov", "avi", "wav", "csv", "html", "htm", "zip"]);

/** Media and document families whose declared MIME type should agree with the extension. */
const FAMILY_BY_EXTENSION: Record<string, string> = {
  pdf: "pdf", doc: "office", docx: "office", xls: "office", xlsx: "office", ppt: "office", pptx: "office",
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image", heic: "image", avif: "image", bmp: "image",
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", ogg: "audio",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video",
  txt: "text", csv: "text", md: "text",
};

function mimeFamily(mime: string): string | null {
  if (mime === "application/pdf") return "pdf";
  if (/^application\/(msword|vnd\.ms-|vnd\.openxmlformats-officedocument)/.test(mime)) return "office";
  if (/^application\/(x-msdownload|x-msdos-program|x-executable|x-dosexec|vnd\.microsoft\.portable-executable|x-msi|x-sh|x-bat)/.test(mime)) return "executable";
  const top = mime.split("/")[0];
  return top === "image" || top === "audio" || top === "video" || top === "text" ? top : null;
}

function isRisky(extension: string) {
  return EXECUTABLE.has(extension) || SCRIPT.has(extension) || MACRO.has(extension);
}

// Bidi overrides and zero-width characters can make "exe.pdf" render as something else.
const HIDDEN_CHARACTERS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

export function fileRiskSignals(name: string, mimeType: string | null): FileRiskSignal[] {
  const signals = new Set<FileRiskSignal>();
  const normalized = name.normalize("NFC").toLowerCase().trim();
  if (HIDDEN_CHARACTERS.test(normalized)) signals.add("hidden-extension");
  // Padding like "photo.jpg          .exe" pushes the real extension out of view.
  if (/\s{4,}\.[a-z0-9]+$/.test(normalized)) signals.add("hidden-extension");

  const parts = normalized.replaceAll(new RegExp(HIDDEN_CHARACTERS.source, "g"), "").replace(/[\s.]+$/, "").split(".").map((part) => part.trim());
  const extension = parts.length > 1 ? parts.at(-1)! : "";
  const previous = parts.length > 2 ? parts.at(-2)! : "";

  if (!extension) signals.add("no-extension");
  if (EXECUTABLE.has(extension)) signals.add("executable");
  if (SCRIPT.has(extension)) signals.add("script");
  if (MACRO.has(extension)) signals.add("macro-document");
  if (DISK_IMAGE.has(extension)) signals.add("disk-image");
  if (ARCHIVE.has(extension)) signals.add("archive");
  if (DECOY.has(previous) && (isRisky(extension) || DISK_IMAGE.has(extension))) signals.add("double-extension");

  const declared = (mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
  const declaredFamily = declared ? mimeFamily(declared) : null;
  // Programs and scripts should be declared as programs (scripts may also be plain text);
  // macro documents are still Office files; everything else must match its family.
  const program = EXECUTABLE.has(extension) || SCRIPT.has(extension);
  const expectedFamily = program ? "executable" : MACRO.has(extension) ? "office" : FAMILY_BY_EXTENSION[extension];
  if (declaredFamily === "executable" && !program) signals.add("mime-mismatch");
  else if (declaredFamily && expectedFamily && declaredFamily !== expectedFamily && !(program && declaredFamily === "text")) signals.add("mime-mismatch");

  return [...signals];
}

export type FileRiskLevel = "low" | "medium" | "high";

const RUNNABLE_SIGNALS: readonly FileRiskSignal[] = ["executable", "script", "macro-document", "disk-image"];

/**
 * Local disguise evidence always wins. Otherwise Jev's score decides (0 benign … 3 very likely
 * malicious), and anything that can run code is at least worth a suggestion.
 * `score`/`disguised` are null when the model couldn't be reached.
 */
export function riskLevel(signals: FileRiskSignal[], score: number | null, disguised: number | null): FileRiskLevel {
  if (signals.some((signal) => DISGUISE_SIGNALS.includes(signal))) return "high";
  if ((score !== null && score >= 2) || (disguised !== null && disguised >= 0.8)) return "high";
  if ((score !== null && score >= 1.25) || signals.some((signal) => RUNNABLE_SIGNALS.includes(signal)) || signals.includes("mime-mismatch")) return "medium";
  return "low";
}

/** Signals that mean a file is disguised; these always mark it high risk, whatever the model says. */
export const DISGUISE_SIGNALS: readonly FileRiskSignal[] = ["double-extension", "hidden-extension"];

export const SIGNAL_LABELS: Record<FileRiskSignal, string> = {
  executable: "Runs as a program",
  script: "Script that can run commands",
  "macro-document": "Office document that can run macros",
  "disk-image": "Disk image that can contain programs",
  archive: "Archive that can hide other files",
  "double-extension": "Hidden program behind a document-like name",
  "hidden-extension": "Name hides its real file type",
  "mime-mismatch": "Name and file type don’t match",
  "no-extension": "No file type in the name",
};
