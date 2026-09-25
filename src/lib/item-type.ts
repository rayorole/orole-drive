import "server-only";

import { sql } from "drizzle-orm";
import { driveItems } from "@/lib/drive-schema";

/** Classifies a `drive_items` row (unaliased in the query) as folder, image, video, audio, pdf, code, archive, text or other. */
export const itemType = sql<string>`case
  when ${driveItems.kind} = 'folder' then 'folder'
  when ${driveItems.name} ~* '\\.(json|jsonl|js|jsx|ts|tsx|mjs|cjs|html?|css|scss|less|xml|svg|ya?ml|toml|ini|conf|sh|bash|zsh|ps1|bat|cmd|py|rb|php|go|rs|java|kt|swift|c|h|cpp|hpp|cs|sql|vue|svelte|dockerfile|gitignore)$'
    or ${driveItems.mimeType} in ('application/json', 'application/xml', 'text/html', 'text/css', 'text/javascript', 'application/javascript') then 'code'
  when ${driveItems.mimeType} like 'image/%' then 'image'
  when ${driveItems.mimeType} like 'video/%' then 'video'
  when ${driveItems.mimeType} like 'audio/%' then 'audio'
  when ${driveItems.mimeType} = 'application/pdf' or ${driveItems.name} ~* '\\.pdf$' then 'pdf'
  when ${driveItems.name} ~* '\\.(zip|rar|7z|tar|gz|bz2|xz|tgz|zst)$'
    or ${driveItems.mimeType} in ('application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed', 'application/gzip', 'application/x-tar') then 'archive'
  when ${driveItems.mimeType} like 'text/%' or ${driveItems.name} ~* '\\.(txt|md|markdown|csv|tsv|log|rst|nfo)$' then 'text'
  else 'other' end`;
