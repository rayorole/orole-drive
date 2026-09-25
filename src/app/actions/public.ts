"use server";

import { DriveError } from "@/lib/drive-errors";
import { getPublicFolderFile, getPublicFolderManifest, getPublicShare } from "@/lib/public-share";
import type { ActionResult, DriveArchiveManifest } from "@/lib/drive-types";

type PublicFileUrls = { downloadUrl: string; previewUrl: string | null };

export async function getPublicAccess(token: string): Promise<ActionResult<PublicFileUrls>> {
  try {
    const file = await getPublicShare(token);
    if (file?.kind !== "file") return { success: false, error: "This file is no longer shared. Ask the owner for a new link." };
    return { success: true, data: { downloadUrl: file.downloadUrl, previewUrl: file.previewUrl } };
  } catch {
    return { success: false, error: "The file could not be reached. Try again in a moment." };
  }
}

/** Fresh URLs for a file inside a shared folder; the file must still sit inside that share. */
export async function getPublicFolderFileAccess(token: string, fileId: string): Promise<ActionResult<PublicFileUrls>> {
  try {
    const file = await getPublicFolderFile(token, fileId);
    if (!file) return { success: false, error: "This file is no longer shared. Ask the owner for a new link." };
    return { success: true, data: { downloadUrl: file.downloadUrl, previewUrl: file.previewUrl } };
  } catch {
    return { success: false, error: "The file could not be reached. Try again in a moment." };
  }
}

export async function getPublicFolderArchive(token: string, folderId: string): Promise<ActionResult<DriveArchiveManifest>> {
  try {
    const manifest = await getPublicFolderManifest(token, folderId);
    if (!manifest) return { success: false, error: "This folder is no longer shared. Ask the owner for a new link." };
    return { success: true, data: manifest };
  } catch (error) {
    return { success: false, error: error instanceof DriveError ? error.message : "The folder could not be reached. Try again in a moment." };
  }
}
