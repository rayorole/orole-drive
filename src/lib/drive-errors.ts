export class DriveError extends Error {}

export class LockedFolderError extends DriveError {
  readonly lockedFolder: { id: string; name: string };

  constructor(folder: { id: string; name: string }) {
    super("Unlock this folder to continue.");
    this.name = "LockedFolderError";
    this.lockedFolder = { id: folder.id, name: folder.name };
  }
}
