"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { unlockFolder } from "@/app/actions/folder-security";
import type { ActionResult, DriveNameConflict, LockedFolder } from "@/lib/drive-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/spinner";

type FolderAccess = { run: <T>(operation: () => Promise<ActionResult<T>>) => Promise<T> };
type UnlockRequest = { folder: LockedFolder; resolve: () => void; reject: (error: Error) => void; promise: Promise<void> };
const FolderAccessContext = createContext<FolderAccess | null>(null);

export class DriveAccessError extends Error {
  readonly lockedFolder?: LockedFolder;
  /** Set when the destination already has items with these names; ask the user and retry with resolutions. */
  readonly conflicts?: DriveNameConflict[];
  constructor(error: string, lockedFolder?: LockedFolder, conflicts?: DriveNameConflict[]) {
    super(error);
    this.name = "DriveAccessError";
    this.lockedFolder = lockedFolder;
    this.conflicts = conflicts;
  }
}

export function FolderAccessProvider({ children }: { children: ReactNode }) {
  const queue = useRef<UnlockRequest[]>([]);
  const unlockEpoch = useRef(0);
  const unlockedAt = useRef(new Map<string, number>());
  const [active, setActive] = useState<UnlockRequest | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const requestUnlock = useCallback((folder: LockedFolder) => {
    const existing = queue.current.find((request) => request.folder.id === folder.id);
    if (existing) return existing.promise;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
    const request = { folder, promise, resolve, reject };
    queue.current.push(request);
    if (queue.current.length === 1) setActive(request);
    return promise;
  }, []);

  const run = useCallback(async <T,>(operation: () => Promise<ActionResult<T>>): Promise<T> => {
    for (;;) {
      const startedAt = unlockEpoch.current;
      const result = await operation();
      if (result.success) return result.data;
      if (!result.lockedFolder) throw new DriveAccessError(result.error, undefined, result.conflicts);
      if ((unlockedAt.current.get(result.lockedFolder.id) ?? 0) > startedAt) continue;
      await requestUnlock(result.lockedFolder);
    }
  }, [requestUnlock]);

  useEffect(() => () => {
    for (const request of queue.current) request.reject(new Error("Unlock cancelled."));
    queue.current = [];
  }, []);

  function finish(cancelled: boolean) {
    const request = queue.current.shift();
    if (cancelled) request?.reject(new Error("Unlock cancelled."));
    else if (request) {
      unlockedAt.current.set(request.folder.id, ++unlockEpoch.current);
      request.resolve();
    }
    setPassword("");
    setError("");
    setActive(queue.current[0] ?? null);
  }

  async function submit() {
    if (!active || pending || !password) return;
    setPending(true);
    setError("");
    try {
      const result = await unlockFolder({ id: active.folder.id, password });
      if (result.success) finish(false);
      else if (result.lockedFolder && result.lockedFolder.id !== active.folder.id) {
        // An ancestor may have been locked while this prompt was open.
        active.folder = result.lockedFolder;
        setActive({ ...active });
        setPassword("");
        setError("Unlock the containing folder first.");
      } else setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not unlock this folder. Try again.");
    } finally {
      setPending(false);
    }
  }

  const value = useMemo(() => ({ run }), [run]);
  return <FolderAccessContext.Provider value={value}>
    {children}
    <Dialog open={active !== null} onOpenChange={(open) => { if (!open && !pending) finish(true); }}>
      {active && <DialogContent showCloseButton={!pending}>
        <form className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <DialogHeader>
            <DialogTitle>Unlock folder</DialogTitle>
            <DialogDescription className="break-words">Enter the password for “{active.folder.name}” to continue. It stays unlocked for one hour in this session.</DialogDescription>
          </DialogHeader>
          <FieldGroup><Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="folder-unlock-password">Folder password</FieldLabel>
            <Input id="folder-unlock-password" name="password" type="password" autoComplete="current-password" autoFocus required value={password} disabled={pending} onChange={(event) => { setPassword(event.target.value); setError(""); }} aria-invalid={Boolean(error)} aria-describedby={error ? "folder-unlock-error" : undefined} />
            {error && <FieldError id="folder-unlock-error" role="alert">{error}</FieldError>}
          </Field></FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => finish(true)}>Cancel</Button>
            <Button type="submit" disabled={pending || !password}>{pending && <Spinner />}Unlock</Button>
          </DialogFooter>
        </form>
      </DialogContent>}
    </Dialog>
  </FolderAccessContext.Provider>;
}

export function useFolderAccess(): FolderAccess {
  const value = useContext(FolderAccessContext);
  if (!value) throw new Error("Folder access requires FolderAccessProvider.");
  return value;
}
