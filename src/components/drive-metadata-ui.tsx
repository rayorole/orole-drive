"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Star, X } from "lucide-react";
import { toast } from "sonner";
import { setFolderColor, setItemDescription, setItemTags, toggleFavorite } from "@/app/actions/drive-metadata";
import { FOLDER_COLORS } from "@/lib/drive-types";
import type { DriveItem } from "@/lib/drive-types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/spinner";
import { DriveFileIcon } from "@/components/drive-item";
import { useFolderAccess } from "@/components/folder-access";
import { FileScanBadge } from "@/components/file-scan-badge";

const colorSwatchClass: Record<string, string> = {
  blue: "bg-blue-500", green: "bg-green-500", amber: "bg-amber-500",
  red: "bg-red-500", violet: "bg-violet-500", gray: "bg-gray-500",
};

export function DriveMetadataDialog({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { run } = useFolderAccess();
  const [favorite, setFavorite] = useState(item.isFavorite);
  const [tags, setTags] = useState<string[]>(item.tags);
  const [tagInput, setTagInput] = useState("");
  const [description, setDescription] = useState(item.description);
  const [color, setColor] = useState<string | null>(item.folderColor);

  function invalidate() { void queryClient.invalidateQueries({ queryKey: ["drive"] }); }

  const favoriteMutation = useMutation({
    mutationFn: () => run(() => toggleFavorite(item.id)),
    onSuccess: (result) => { setFavorite(result.favorited); invalidate(); },
    onError: (error) => toast.error(error.message),
  });
  const colorMutation = useMutation({
    mutationFn: (next: string | null) => run(() => setFolderColor(item.id, next)),
    onSuccess: (_result, next) => { setColor(next); invalidate(); },
    onError: (error) => toast.error(error.message),
  });
  const saveMutation = useMutation({
    mutationFn: async () => {
      await run(() => setItemTags(item.id, tags));
      await run(() => setItemDescription(item.id, description.trim()));
    },
    onSuccess: () => { toast.success("Details saved"); invalidate(); },
    onError: (error) => toast.error(error.message),
  });

  function addTag() {
    const next = tagInput.trim().toLowerCase().slice(0, 32);
    if (next && !tags.includes(next) && tags.length < 20) setTags([...tags, next]);
    setTagInput("");
  }
  function removeTag(tag: string) { setTags(tags.filter((existing) => existing !== tag)); }

  return <Dialog open onOpenChange={(open) => { if (!open && !saveMutation.isPending) onClose(); }}>
    <DialogContent showCloseButton={!saveMutation.isPending} className="sm:max-w-md">
      <DialogHeader>
        <div className="flex items-center gap-3">
          <DriveFileIcon item={{ ...item, folderColor: color }} />
          <div className="min-w-0"><DialogTitle className="truncate">{item.name}</DialogTitle><DialogDescription>Favorites, tags, notes and color for this {item.kind}.</DialogDescription></div>
        </div>
      </DialogHeader>
      <FieldGroup>
        {item.kind === "file" && <Field>
          <FieldLabel>VirusTotal</FieldLabel>
          <FileScanBadge itemId={item.id} size={item.size} />
        </Field>}
        <Field orientation="horizontal">
          <Button type="button" variant="outline" size="sm" disabled={favoriteMutation.isPending} onClick={() => favoriteMutation.mutate()}>
            {favoriteMutation.isPending ? <Spinner /> : <Star className={cn("size-4", favorite && "fill-amber-400 text-amber-400")} />}
            {favorite ? "Favorited" : "Add to favorites"}
          </Button>
        </Field>
        {item.kind === "folder" && <Field>
          <FieldLabel>Folder color</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" aria-label="No color" aria-pressed={color === null} disabled={colorMutation.isPending} onClick={() => colorMutation.mutate(null)} className={cn("size-6 rounded-full border border-dashed border-muted-foreground/50", color === null && "ring-2 ring-ring ring-offset-2 ring-offset-background")} />
            {FOLDER_COLORS.map((value) => <button key={value} type="button" aria-label={`${value} folder color`} aria-pressed={color === value} disabled={colorMutation.isPending} onClick={() => colorMutation.mutate(value)} className={cn("size-6 rounded-full", colorSwatchClass[value], color === value && "ring-2 ring-ring ring-offset-2 ring-offset-background")} />)}
          </div>
        </Field>}
        <Field>
          <FieldLabel htmlFor="drive-item-tags">Tags</FieldLabel>
          <div className="flex gap-2">
            <Input id="drive-item-tags" value={tagInput} placeholder="Add a tag…" maxLength={32} disabled={saveMutation.isPending} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addTag(); } }} />
            <Button type="button" variant="outline" size="sm" disabled={!tagInput.trim() || tags.length >= 20 || saveMutation.isPending} onClick={addTag}>Add</Button>
          </div>
          {tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{tags.map((tag) => <Badge key={tag} variant="secondary">{tag}<button type="button" aria-label={`Remove tag ${tag}`} disabled={saveMutation.isPending} onClick={() => removeTag(tag)} className="ml-0.5 outline-none"><X data-icon="inline-end" className="size-3" /></button></Badge>)}</div>}
        </Field>
        <Field>
          <FieldLabel htmlFor="drive-item-notes">Notes</FieldLabel>
          <textarea id="drive-item-notes" value={description} maxLength={2_000} disabled={saveMutation.isPending} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder="Add a note about this file or folder…" className="w-full min-w-0 resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30" />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={saveMutation.isPending}>Close</Button>
        <Button type="button" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>{saveMutation.isPending && <Spinner />}Save details</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
