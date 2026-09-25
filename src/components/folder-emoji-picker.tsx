"use client";

import { useState } from "react";
import { EmojiPicker } from "frimousse";
import { Smile } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";

export function FolderEmojiPicker({ value, disabled, onChange }: {
  value: string | null;
  disabled: boolean;
  onChange: (emoji: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return <div className="flex items-center gap-2">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" size="sm" disabled={disabled} />}>
        {value ? <span aria-hidden="true" className="text-lg">{value}</span> : <Smile />}Choose emoji
      </PopoverTrigger>
      <PopoverContent align="start" className="w-fit max-w-[calc(100vw-2rem)] p-0">
        <PopoverTitle className="sr-only">Folder emoji</PopoverTitle>
        <EmojiPicker.Root columns={8} className="isolate flex h-80 w-fit flex-col" onEmojiSelect={({ emoji }) => { onChange(emoji); setOpen(false); }}>
          <EmojiPicker.Search autoFocus aria-label="Search folder emoji" placeholder="Search emoji…" className="mx-2 mt-2 rounded-md border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <EmojiPicker.Viewport className="relative min-h-0 flex-1 outline-none">
            <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center px-4 text-sm text-muted-foreground">Loading emoji…</EmojiPicker.Loading>
            <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center px-4 text-sm text-muted-foreground">No emoji found. Try another search.</EmojiPicker.Empty>
            <EmojiPicker.List className="select-none pb-2" components={{
              CategoryHeader: ({ category, ...props }) => <div {...props} className="bg-popover px-3 pb-1.5 pt-3 text-xs font-medium text-muted-foreground">{category.label}</div>,
              Row: ({ children, ...props }) => <div {...props} className="scroll-my-1.5 px-2">{children}</div>,
              Emoji: ({ emoji, ...props }) => <button {...props} type="button" className="flex size-8 items-center justify-center rounded-md text-lg outline-none data-[active]:bg-accent focus-visible:ring-2 focus-visible:ring-ring">{emoji.emoji}</button>,
            }} />
          </EmojiPicker.Viewport>
        </EmojiPicker.Root>
      </PopoverContent>
    </Popover>
    {value && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>Clear emoji</Button>}
  </div>;
}
