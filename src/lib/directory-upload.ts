export type UploadTreeNode =
  | { kind: "file"; file: File }
  | { kind: "directory"; name: string; children: UploadTreeNode[] };

export type UploadDirectoryHandle = {
  kind: "directory";
  name: string;
  values: () => AsyncIterable<UploadDirectoryHandle | UploadFileHandle>;
};
type UploadFileHandle = { kind: "file"; name: string; getFile: () => Promise<File> };
type DropSource = {
  handle?: Promise<UploadDirectoryHandle | UploadFileHandle | null>;
  entry: FileSystemEntry | null;
  file: File | null;
};
export type UploadDropSnapshot = { sources: DropSource[]; files: File[] };

function validateName(name: string) {
  const normalized = name.trim().normalize();
  if (!normalized || normalized === "." || normalized === ".." || /[/\\\p{Cc}\p{Bidi_Control}]/u.test(name) ||
    !name.isWellFormed() || new TextEncoder().encode(normalized).length > 255) {
    throw new Error(`“${name}” has a name that cannot be uploaded. Rename it and try again.`);
  }
}

function validateDepth(depth: number) {
  if (depth > 64) throw new Error("This folder has more than 64 nested levels. Choose a shallower folder.");
}

// DataTransfer becomes protected after the drop handler returns. Capture entries,
// files, and handle promises here, before traversal yields to the browser.
export function snapshotDataTransfer(transfer: DataTransfer): UploadDropSnapshot {
  const files = Array.from(transfer.files);
  const sources = Array.from(transfer.items).filter((item) => item.kind === "file").map((item): DropSource => {
    const extended = item as DataTransferItem & {
      getAsFileSystemHandle?: () => Promise<UploadDirectoryHandle | UploadFileHandle | null>;
    };
    let handle: DropSource["handle"];
    try {
      handle = extended.getAsFileSystemHandle?.().catch(() => null);
    } catch {
      // Legacy entries remain usable if the handle API is unavailable.
    }
    return { handle, entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile() };
  });
  return { sources, files };
}

export function treeFromRelativeFiles(files: File[]): UploadTreeNode[] {
  const roots: UploadTreeNode[] = [];
  const directories = new Map<string, Extract<UploadTreeNode, { kind: "directory" }>>();
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).split("/");
    parts.forEach(validateName);
    validateDepth(parts.length - 1);
    if (parts.at(-1) !== file.name) throw new Error("A selected file has an invalid relative path. Choose the folder again.");
    let children = roots;
    let path = "";
    for (const name of parts.slice(0, -1)) {
      path = path ? `${path}/${name}` : name;
      let directory = directories.get(path);
      if (!directory) {
        directory = { kind: "directory", name, children: [] };
        directories.set(path, directory);
        children.push(directory);
      }
      children = directory.children;
    }
    // Duplicate files are separate uploads, never replacements of earlier bytes.
    children.push({ kind: "file", file });
  }
  return roots;
}

export async function treeFromDirectoryHandle(handle: UploadDirectoryHandle | UploadFileHandle, signal: AbortSignal, depth = 0): Promise<UploadTreeNode> {
  signal.throwIfAborted();
  validateName(handle.name);
  if (handle.kind === "file") {
    const file = await handle.getFile();
    signal.throwIfAborted();
    validateName(file.name);
    return { kind: "file", file };
  }
  validateDepth(depth + 1);
  const children: UploadTreeNode[] = [];
  for await (const child of handle.values()) {
    signal.throwIfAborted();
    children.push(await treeFromDirectoryHandle(child, signal, depth + 1));
  }
  return { kind: "directory", name: handle.name, children };
}

async function treeFromEntry(entry: FileSystemEntry, signal: AbortSignal, depth = 0): Promise<UploadTreeNode> {
  signal.throwIfAborted();
  validateName(entry.name);
  if (entry.isFile) {
    const result = Promise.withResolvers<File>();
    (entry as FileSystemFileEntry).file(result.resolve, result.reject);
    const file = await result.promise;
    signal.throwIfAborted();
    validateName(file.name);
    return { kind: "file", file };
  }
  if (!entry.isDirectory) throw new Error(`Could not read “${entry.name}”. Choose it again using Upload folder.`);
  validateDepth(depth + 1);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: UploadTreeNode[] = [];
  // Chromium returns at most one batch (often 100 entries) per call.
  while (true) {
    signal.throwIfAborted();
    const result = Promise.withResolvers<FileSystemEntry[]>();
    reader.readEntries(result.resolve, result.reject);
    const batch = await result.promise;
    signal.throwIfAborted();
    if (!batch.length) break;
    for (const child of batch) children.push(await treeFromEntry(child, signal, depth + 1));
  }
  return { kind: "directory", name: entry.name, children };
}

export async function treeFromDrop(snapshot: UploadDropSnapshot, signal: AbortSignal): Promise<UploadTreeNode[]> {
  if (!snapshot.sources.length) return treeFromRelativeFiles(snapshot.files);
  if (snapshot.sources.every((source) => !source.entry && !source.handle && source.file)) {
    return treeFromRelativeFiles(snapshot.sources.map((source) => source.file!));
  }
  const roots: UploadTreeNode[] = [];
  for (const source of snapshot.sources) {
    signal.throwIfAborted();
    const handle = await source.handle;
    if (handle) roots.push(await treeFromDirectoryHandle(handle, signal));
    else if (source.entry) roots.push(await treeFromEntry(source.entry, signal));
    else if (source.file) roots.push(...treeFromRelativeFiles([source.file]));
    else throw new Error("This browser could not read a dropped item. Try Upload folder instead.");
  }
  return roots;
}

export function chooseDirectoryFiles(signal: AbortSignal): Promise<File[]> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<File[]>();
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.setAttribute("webkitdirectory", "");
  input.hidden = true;
  const cleanup = () => {
    signal.removeEventListener("abort", abort);
    input.remove();
  };
  const abort = () => { cleanup(); reject(new DOMException("Folder selection cancelled.", "AbortError")); };
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    cleanup();
    resolve(files);
  }, { once: true });
  input.addEventListener("cancel", abort, { once: true });
  signal.addEventListener("abort", abort, { once: true });
  document.body.append(input);
  try {
    input.click();
  } catch (error) {
    cleanup();
    reject(error);
  }
  return promise;
}
