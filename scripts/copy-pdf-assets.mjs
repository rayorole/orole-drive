import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const source = dirname(require.resolve("pdfjs-dist/package.json"));
const destination = new URL("../public/pdf-assets/", import.meta.url);
await mkdir(destination, { recursive: true });
await Promise.all(["cmaps", "standard_fonts", "wasm"].map((name) =>
  cp(join(source, name), new URL(`${name}/`, destination), { recursive: true }),
));
