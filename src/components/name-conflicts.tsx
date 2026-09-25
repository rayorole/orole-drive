"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ConflictResolution, ConflictResolutions, DriveNameConflict } from "@/lib/drive-types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** What the incoming items are doing; decides what "Replace" means. */
export type ConflictOperation = "upload" | "move" | "copy";
type ConflictRequest = {
  conflicts: DriveNameConflict[];
  operation: ConflictOperation;
  destinationName: string;
  resolve: (resolutions: ConflictResolutions | null) => void;
};
type NameConflictPrompt = {
  /**
   * Asks how to resolve each conflict, one at a time, with "Do this for all remaining".
   * Resolves to a resolution per conflict id, or null when the user cancels the whole operation.
   * Concurrent requests queue behind each other.
   */
  resolveConflicts: (conflicts: DriveNameConflict[], options: { operation: ConflictOperation; destinationName: string }) => Promise<ConflictResolutions | null>;
};

const NameConflictContext = createContext<NameConflictPrompt | null>(null);

export function NameConflictProvider({ children }: { children: ReactNode }) {
  const queue = useRef<ConflictRequest[]>([]);
  const [active, setActive] = useState<ConflictRequest | null>(null);
  const [index, setIndex] = useState(0);
  const [applyToAll, setApplyToAll] = useState(false);
  const answers = useRef<ConflictResolutions>({});

  const resolveConflicts = useCallback<NameConflictPrompt["resolveConflicts"]>((conflicts, { operation, destinationName }) => {
    if (!conflicts.length) return Promise.resolve({});
    const { promise, resolve } = Promise.withResolvers<ConflictResolutions | null>();
    queue.current.push({ conflicts, operation, destinationName, resolve });
    if (queue.current.length === 1) {
      answers.current = {};
      setIndex(0);
      setApplyToAll(false);
      setActive(queue.current[0]);
    }
    return promise;
  }, []);

  useEffect(() => () => {
    for (const request of queue.current) request.resolve(null);
    queue.current = [];
  }, []);

  function finish(result: ConflictResolutions | null) {
    const request = queue.current.shift();
    request?.resolve(result);
    answers.current = {};
    setIndex(0);
    setApplyToAll(false);
    setActive(queue.current[0] ?? null);
  }

  function choose(resolution: ConflictResolution) {
    if (!active) return;
    const remaining = active.conflicts.slice(index);
    for (const conflict of applyToAll ? remaining : remaining.slice(0, 1)) answers.current[conflict.id] = resolution;
    const next = applyToAll ? active.conflicts.length : index + 1;
    if (next >= active.conflicts.length) finish({ ...answers.current });
    else { setIndex(next); setApplyToAll(false); }
  }

  const conflict = active?.conflicts[index];
  const remaining = active ? active.conflicts.length - index : 0;
  // Uploads keep the old contents as a version; moves and copies send the existing item to Trash.
  // A folder can't become a version of anything, so for folders both operations mean Trash.
  const replaceKeepsVersion = active?.operation === "upload" && conflict?.kind === "file" && conflict.existingKind === "file";
  const replaceHint = replaceKeepsVersion ? "The current file is kept in its version history." : "The existing item moves to Trash, where you can restore it.";

  return <NameConflictContext.Provider value={{ resolveConflicts }}>
    {children}
    <Dialog open={Boolean(conflict)} onOpenChange={(open) => { if (!open) finish(null); }}>
      {active && conflict && <DialogContent>
        <DialogHeader>
          <DialogTitle className="break-words">“{conflict.name}” already exists</DialogTitle>
          <DialogDescription className="break-words">
            {active.destinationName} already has {conflict.existingKind === "folder" ? "a folder" : "a file"} with this name.
            {remaining > 1 && ` ${remaining} conflicts left.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button variant="outline" className="h-auto justify-start whitespace-normal py-2.5 text-left" onClick={() => choose("replace")}>
            <span className="flex flex-col gap-0.5"><span className="font-medium">Replace</span><span className="text-xs font-normal text-muted-foreground">{replaceHint}</span></span>
          </Button>
          <Button variant="outline" className="h-auto justify-start whitespace-normal py-2.5 text-left" onClick={() => choose("keep-both")}>
            <span className="flex flex-col gap-0.5"><span className="font-medium">Keep both</span><span className="text-xs font-normal text-muted-foreground">The {active.operation === "upload" ? "uploaded" : active.operation === "move" ? "moved" : "copied"} {conflict.kind} gets a numbered name.</span></span>
          </Button>
          <Button variant="outline" className="h-auto justify-start whitespace-normal py-2.5 text-left" onClick={() => choose("skip")}>
            <span className="flex flex-col gap-0.5"><span className="font-medium">Skip</span><span className="text-xs font-normal text-muted-foreground">Leave this {conflict.kind} out; nothing here changes.</span></span>
          </Button>
        </div>
        <DialogFooter className="items-center sm:justify-between">
          {remaining > 1
            ? <label className="flex items-center gap-2 text-sm"><Checkbox checked={applyToAll} onCheckedChange={(checked) => setApplyToAll(checked === true)} />Do this for all {remaining} conflicts</label>
            : <span />}
          <Button variant="ghost" onClick={() => finish(null)}>Cancel</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </NameConflictContext.Provider>;
}

export function useNameConflicts(): NameConflictPrompt {
  const context = useContext(NameConflictContext);
  if (!context) throw new Error("useNameConflicts must be used inside NameConflictProvider.");
  return context;
}
