"use client";

import { Globe2, UsersRound } from "lucide-react";
import type { DriveSharingStatus } from "@/lib/drive-types";
import { Hint } from "@/components/hint";

export function SharingBadges({ sharing, compact = false }: { sharing: DriveSharingStatus; compact?: boolean }) {
  const publicLabel = sharing.public ? `Public link${sharing.public === "inherited" ? " · inherited from folder" : ""}` : null;
  const memberLabel = sharing.members ? `${sharing.members === "all" ? "Shared with all drive members" : "Shared with selected members"}${sharing.membersInherited ? " · inherited from folder" : ""}` : null;
  if (!publicLabel && !memberLabel) return null;
  if (compact) {
    const label = [publicLabel, memberLabel].filter(Boolean).join(". ");
    const Icon = publicLabel ? Globe2 : UsersRound;
    return <Hint label={label} side="right"><span role="img" aria-label={label} className="inline-flex rounded-full bg-sidebar p-0.5 text-primary"><Icon className="size-3" aria-hidden="true" /></span></Hint>;
  }
  return <span className="inline-flex shrink-0 items-center gap-1">
    {publicLabel && <Hint label={publicLabel}><span role="img" aria-label={publicLabel} className="inline-flex text-primary"><Globe2 className="size-3.5" aria-hidden="true" /></span></Hint>}
    {memberLabel && <Hint label={memberLabel}><span role="img" aria-label={memberLabel} className="inline-flex text-muted-foreground"><UsersRound className="size-3.5" aria-hidden="true" /></span></Hint>}
  </span>;
}
