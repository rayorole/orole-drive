import type { DriveArchiveItem, DriveArchiveManifest } from "./drive-types";

export type ArchiveEntry = { item: DriveArchiveItem; path: string };
export type ArchivePlan = { entries: ArchiveEntry[]; totalBytes: number; totalFiles: number; filename: string };

const encoder = new TextEncoder();
const componentByteLimit = 240;

function truncateUtf8(value: string, limit: number) {
  if (encoder.encode(value).length <= limit) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const length = encoder.encode(character).length;
    if (bytes + length > limit) break;
    result += character;
    bytes += length;
  }
  return result;
}

/** One portable filename, never a path or a Windows device/alternate stream. */
export function safeArchiveName(name: string, fallback = "Untitled") {
  let safe = name.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu, "_").trim().replace(/[. ]+$/u, "");
  if (!safe || safe === "." || safe === "..") safe = fallback;
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(safe)) safe = `_${safe}`;
  const dot = safe.lastIndexOf(".");
  const extension = dot > 0 ? safe.slice(dot) : "";
  const extensionBytes = encoder.encode(extension).length;
  if (extension && extensionBytes < 80) {
    return `${truncateUtf8(safe.slice(0, dot), componentByteLimit - extensionBytes)}${extension}`;
  }
  return truncateUtf8(safe, componentByteLimit).replace(/[. ]+$/u, "") || fallback;
}

function pathKey(name: string) {
  return name.normalize("NFKC").toLowerCase();
}

function compareItems(a: DriveArchiveItem, b: DriveArchiveItem) {
  const left = a.name.normalize("NFC");
  const right = b.name.normalize("NFC");
  return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function siblingNames(items: DriveArchiveItem[]) {
  const bases = items.map((item) => safeArchiveName(item.name, item.kind === "folder" ? "Folder" : "File"));
  const reserved = new Set(bases.map(pathKey));
  const used = new Set<string>();
  return bases.map((base, index) => {
    let name = base;
    if (used.has(pathKey(base))) {
      const dot = items[index].kind === "file" ? base.lastIndexOf(".") : -1;
      const extension = dot > 0 ? base.slice(dot) : "";
      const stem = extension ? base.slice(0, dot) : base;
      let suffix = 2;
      do {
        const ending = ` (${suffix++})${extension}`;
        // Extremely long extensions are treated as part of the stem.
        const shortEnding = encoder.encode(ending).length < 100 ? ending : ` (${suffix - 1})`;
        name = `${truncateUtf8(shortEnding === ending ? stem : base, componentByteLimit - encoder.encode(shortEnding).length)}${shortEnding}`;
      } while (used.has(pathKey(name)) || reserved.has(pathKey(name)));
    }
    used.add(pathKey(name));
    return name;
  });
}

/** Keeps selected roots at the ZIP root and includes each descendant exactly once. */
export function planArchive(manifest: DriveArchiveManifest): ArchivePlan {
  const byId = new Map<string, DriveArchiveItem>();
  for (const item of manifest.items) {
    if (!Number.isSafeInteger(item.size) || item.size < 0) throw new Error("A file has an invalid size. Refresh the drive and try again.");
    const previous = byId.get(item.id);
    if (previous && (previous.parentId !== item.parentId || previous.kind !== item.kind || previous.name !== item.name || previous.size !== item.size)) {
      throw new Error("The folder contents changed. Refresh the drive and try again.");
    }
    byId.set(item.id, item);
  }
  const selected = new Set(manifest.rootIds);
  if (!selected.size) throw new Error("Select at least one file or folder to download.");
  const roots: DriveArchiveItem[] = [];
  for (const id of selected) {
    const item = byId.get(id);
    if (!item) throw new Error("A selected item is no longer available. Refresh the drive and try again.");
    let parentId = item.parentId;
    let covered = false;
    const ancestors = new Set([id]);
    while (parentId && byId.has(parentId)) {
      if (ancestors.has(parentId)) throw new Error("The archive contains a circular folder path.");
      ancestors.add(parentId);
      if (selected.has(parentId)) covered = true;
      parentId = byId.get(parentId)!.parentId;
    }
    if (!covered) roots.push(item);
  }

  const children = new Map<string, DriveArchiveItem[]>();
  for (const item of byId.values()) {
    if (!item.parentId) continue;
    const siblings = children.get(item.parentId);
    if (siblings) siblings.push(item);
    else children.set(item.parentId, [item]);
  }
  const entries: ArchiveEntry[] = [];
  const visited = new Set<string>();
  let totalBytes = 0;
  let totalFiles = 0;
  function visit(items: DriveArchiveItem[], parentPath: string, depth: number) {
    if (depth > 64) throw new Error("The archive's folder structure is too deep.");
    items.sort(compareItems);
    const names = siblingNames(items);
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (visited.has(item.id)) throw new Error("The archive contains a circular folder path.");
      visited.add(item.id);
      const path = `${parentPath}${names[index]}${item.kind === "folder" ? "/" : ""}`;
      entries.push({ item, path });
      const descendants = children.get(item.id);
      if (item.kind === "folder") {
        if (descendants?.length) visit(descendants, path, depth + 1);
      } else {
        if (descendants?.length) throw new Error("A file cannot contain other files.");
        totalFiles++;
        totalBytes += item.size;
        if (!Number.isSafeInteger(totalBytes)) throw new Error("The selected archive is too large to measure safely.");
      }
    }
  }
  visit(roots, "", 1);
  if (visited.size !== byId.size) throw new Error("The folder contents changed. Refresh the drive and try again.");
  const filename = roots.length === 1 ? `${safeArchiveName(roots[0].name)}.zip` : "Orole Drive.zip";
  return { entries, totalBytes, totalFiles, filename };
}
