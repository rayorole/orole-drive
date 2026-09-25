"use server";

import { z } from "zod";
import { driveAction } from "@/lib/drive-access";
import { recordDriveOpened, setDriveFavorites, setDriveFolderColor, setDriveItemDescription, setDriveItemTags, toggleDriveFavorite } from "@/lib/drive-metadata";
import { FOLDER_COLORS } from "@/lib/drive-types";
import type { ActionResult } from "@/lib/drive-types";

const idSchema = z.uuid("Choose a valid file or folder.");
const tagsSchema = z.array(z.string().max(64)).max(40, "Use up to 20 tags.");
const descriptionSchema = z.string().max(2_000, "Notes must be 2,000 characters or fewer.");
const colorSchema = z.enum(FOLDER_COLORS).nullable();

export async function toggleFavorite(id: string): Promise<ActionResult<{ favorited: boolean }>> {
  return driveAction((ctx) => toggleDriveFavorite(ctx, idSchema.parse(id)));
}

const idsSchema = z.array(idSchema).min(1, "Choose at least one file or folder.").max(1000, "Choose up to 1,000 items at a time.").transform((ids) => [...new Set(ids)]);

export async function setFavorites(ids: string[], favorited: boolean): Promise<ActionResult<void>> {
  return driveAction((ctx) => setDriveFavorites(ctx, idsSchema.parse(ids), z.boolean().parse(favorited)));
}

export async function recordOpened(id: string): Promise<ActionResult<void>> {
  return driveAction((ctx) => recordDriveOpened(ctx, idSchema.parse(id)));
}

export async function setItemTags(id: string, tags: string[]): Promise<ActionResult<void>> {
  return driveAction((ctx) => setDriveItemTags(ctx, idSchema.parse(id), tagsSchema.parse(tags)));
}

export async function setItemDescription(id: string, description: string): Promise<ActionResult<void>> {
  return driveAction((ctx) => setDriveItemDescription(ctx, idSchema.parse(id), descriptionSchema.parse(description)));
}

export async function setFolderColor(id: string, color: string | null): Promise<ActionResult<void>> {
  return driveAction((ctx) => setDriveFolderColor(ctx, idSchema.parse(id), colorSchema.parse(color)));
}
