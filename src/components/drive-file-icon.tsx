import Image from "next/image";
import type { DriveItem } from "@/lib/drive-types";
import { fileIconName } from "@/lib/file-icon";
import { cn } from "@/lib/utils";

export function DriveFileIcon({ item, large = false }: {
  item: Pick<DriveItem, "name" | "kind" | "mimeType">;
  large?: boolean;
}) {
  const name = fileIconName(item);
  const size = large ? 72 : 32;
  return (
    <span aria-hidden="true" className={cn(
      "inline-flex shrink-0 items-center justify-center",
      large ? "size-20" : "size-8",
    )}>
      <Image src={`/file-icons/default/${name}.svg`} alt="" width={size} height={size} unoptimized className="dark:hidden" />
      <Image src={`/file-icons/default/dark/${name}.svg`} alt="" width={size} height={size} unoptimized className="hidden dark:block" />
    </span>
  );
}
