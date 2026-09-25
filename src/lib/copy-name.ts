/** "photo.jpg" → "photo (copy).jpg", then "(copy 2)"… until the name is free in the destination. */
export function copyName(name: string, kind: "file" | "folder", taken: ReadonlySet<string>) {
  if (!taken.has(name)) return name;
  const dot = kind === "file" ? name.lastIndexOf(".") : -1;
  const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    const candidate = `${base.slice(0, 255 - suffix.length - extension.length)}${suffix}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}
