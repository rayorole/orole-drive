import type { UploadTicket } from "@/lib/drive-types";

const MAX_ACTIVE_PUTS = 4;
type SlotWaiter = { signal: AbortSignal; grant: () => void; cancel: () => void };
let activePuts = 0;
const waiting: SlotWaiter[] = [];

function drainSlots() {
  while (activePuts < MAX_ACTIVE_PUTS && waiting.length) {
    const waiter = waiting.shift()!;
    waiter.signal.removeEventListener("abort", waiter.cancel);
    if (waiter.signal.aborted) {
      waiter.cancel();
      continue;
    }
    activePuts += 1;
    waiter.grant();
  }
}

function acquireSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<() => void>();
  const waiter: SlotWaiter = {
    signal,
    grant: () => {
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activePuts -= 1;
        drainSlots();
      });
    },
    cancel: () => {
      const index = waiting.indexOf(waiter);
      if (index !== -1) waiting.splice(index, 1);
      reject(signal.reason);
    },
  };
  waiting.push(waiter);
  signal.addEventListener("abort", waiter.cancel, { once: true });
  drainSlots();
  return promise;
}

async function putBlob(
  url: string,
  body: () => Blob,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
  onBytes: (delta: number) => void,
) {
  const release = await acquireSlot(signal);
  try {
    signal.throwIfAborted();
    const blob = body();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const xhr = new XMLHttpRequest();
    let sent = 0;
    let settled = false;
    let failure: unknown;
    const report = (loaded: number) => {
      if (signal.aborted || settled) return;
      const next = Math.max(sent, Math.min(loaded, blob.size));
      onBytes(next - sent);
      sent = next;
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      xhr.upload.onprogress = null;
      xhr.upload.onload = null;
      xhr.onloadend = null;
      xhr.onerror = null;
      xhr.onabort = null;
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = () => {
      xhr.abort();
      finish(signal.reason);
    };
    try {
      xhr.open("PUT", url);
      if (headers) {
        for (const [header, value] of Object.entries(headers)) xhr.setRequestHeader(header, value);
      }
      xhr.upload.onprogress = (event) => report(event.loaded);
      xhr.upload.onload = () => report(blob.size);
      xhr.onerror = () => { failure = new Error("Upload interrupted. Check your connection and try again."); };
      xhr.onabort = () => { failure = signal.reason ?? new Error("Upload cancelled."); };
      xhr.onloadend = () => {
        if (failure !== undefined) {
          finish(failure);
        } else if (xhr.status >= 200 && xhr.status < 300) {
          report(blob.size);
          finish();
        } else if (xhr.status === 412 && headers?.["If-None-Match"] === "*") {
          // An earlier attempt already stored this upload; completion verifies it matches.
          report(blob.size);
          finish();
        } else {
          finish(new Error(`Storage rejected the upload (${xhr.status}). Try again.`));
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      signal.throwIfAborted();
      xhr.send(blob);
    } catch (error) {
      finish(error);
      xhr.abort();
    }
    await promise;
  } finally {
    release();
  }
}

/** Bytes a resumed multipart upload already has in storage. */
export function completedBytes(ticket: UploadTicket, size: number) {
  if (ticket.mode === "single") return 0;
  return ticket.completedParts.reduce((total, partNumber) => total + Math.min(ticket.partSize, size - (partNumber - 1) * ticket.partSize), 0);
}

/**
 * Sends the ticket's parts (a resumed multipart ticket lists only the missing ones). `onProgress` reports the
 * total bytes stored, including parts sent before. Resolves or rejects only after every active PUT and waiting
 * worker has settled.
 */
export async function transferUpload(
  file: File,
  ticket: UploadTicket,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let nextPart = 0;
  let sent = completedBytes(ticket, file.size);
  onProgress(sent);
  const partCount = ticket.mode === "single" ? 1 : ticket.parts.length;
  const onBytes = (delta: number) => {
    sent += delta;
    onProgress(sent);
  };
  const worker = async () => {
    try {
      while (nextPart < partCount) {
        controller.signal.throwIfAborted();
        const index = nextPart++;
        if (ticket.mode === "single") {
          await putBlob(ticket.url, () => file, ticket.headers, controller.signal, onBytes);
        } else {
          const part = ticket.parts[index];
          const start = (part.partNumber - 1) * ticket.partSize;
          await putBlob(part.url, () => file.slice(start, Math.min(start + ticket.partSize, file.size)), undefined, controller.signal, onBytes);
        }
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  try {
    // Only four workers per file can hold a request or wait for a global FIFO slot.
    await Promise.allSettled(Array.from({ length: Math.min(MAX_ACTIVE_PUTS, partCount) }, worker));
    controller.signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
