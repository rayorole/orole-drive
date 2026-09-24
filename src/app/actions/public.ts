"use server";

import { getPublicFile } from "@/lib/storage";
import type { ActionResult } from "@/lib/drive-types";

export async function getPublicAccess(token: string): Promise<ActionResult<{ downloadUrl: string; previewUrl: string | null }>> {
  try {
    const file = await getPublicFile(token);
    if (!file) return { success: false, error: "This file is no longer shared. Ask the owner for a new link." };
    return { success: true, data: { downloadUrl: file.downloadUrl, previewUrl: file.previewUrl } };
  } catch {
    return { success: false, error: "The file could not be reached. Try again in a moment." };
  }
}
