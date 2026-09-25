import type { DriveNameConflict } from "@/lib/drive-types";

export class DriveError extends Error {}

export class LockedFolderError extends DriveError {
  readonly lockedFolder: { id: string; name: string };

  constructor(folder: { id: string; name: string }) {
    super("Unlock this folder to continue.");
    this.name = "LockedFolderError";
    this.lockedFolder = { id: folder.id, name: folder.name };
  }
}

/** Incoming names collide with items in the destination; the client asks how to resolve each one and retries. */
export class NameConflictError extends DriveError {
  readonly conflicts: DriveNameConflict[];

  constructor(conflicts: DriveNameConflict[]) {
    super(conflicts.length === 1 ? `“${conflicts[0].name}” already exists here.` : `${conflicts.length} items with these names already exist here.`);
    this.name = "NameConflictError";
    this.conflicts = conflicts;
  }
}
