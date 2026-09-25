export function formatBytes(bytes: number) {
  if (bytes === 0) return "0 bytes";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: unit > 0 ? 1 : 0 }).format(bytes / 1024 ** unit)} ${units[unit]}`;
}
