import type { CSSProperties } from "react";
import type { HighlighterCore, ThemedToken } from "shiki/core";
import { bundledLanguagesInfo } from "shiki/langs";

/** Beyond this, tokenizing would block the page long enough to feel broken; plain text stays instant. */
export const HIGHLIGHT_MAX_CHARACTERS = 200_000;
export const HIGHLIGHT_MAX_LINES = 5_000;

const extensionLanguages: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", jsonl: "jsonl", ndjson: "jsonl", ipynb: "json", md: "markdown", markdown: "markdown", mdx: "mdx",
  html: "html", htm: "html", xhtml: "html", xml: "xml", svg: "xml", css: "css", scss: "scss", sass: "sass", less: "less",
  yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", conf: "ini", config: "ini", properties: "ini", editorconfig: "ini", env: "dotenv",
  sql: "sql", graphql: "graphql", gql: "graphql", py: "python", pyw: "python", rb: "ruby", php: "php", go: "go", rs: "rust",
  java: "java", kt: "kotlin", kts: "kotlin", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  swift: "swift", m: "objective-c", mm: "objective-cpp", sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "fish",
  ps1: "powershell", bat: "bat", cmd: "bat", r: "r", lua: "lua", pl: "perl", pm: "perl", vue: "vue", svelte: "svelte", astro: "astro",
  ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang", clj: "clojure", cljs: "clojure", edn: "clojure", scala: "scala",
  dart: "dart", gradle: "groovy", dockerfile: "dockerfile", makefile: "make", tex: "latex", bib: "bibtex", diff: "diff", patch: "diff",
  csv: "csv", tsv: "tsv", log: "log",
};
const fileNameLanguages: Record<string, string> = { dockerfile: "dockerfile", makefile: "make", gemfile: "ruby", rakefile: "ruby", ".env": "dotenv" };

export type CodeLanguage = { id: string; name: string };

/** Resolves a highlighting grammar from the file name only; content is never sniffed. */
export function languageFor(fileName: string): CodeLanguage | null {
  const name = fileName.toLowerCase();
  const dot = name.lastIndexOf(".");
  const id = fileNameLanguages[name] ?? (dot >= 0 ? extensionLanguages[name.slice(dot + 1)] : undefined);
  const info = id ? bundledLanguagesInfo.find((language) => language.id === id || language.aliases?.includes(id)) : undefined;
  return info ? { id: info.id, name: info.name } : null;
}

let highlighter: Promise<HighlighterCore> | undefined;

async function loadHighlighter(): Promise<HighlighterCore> {
  // Runtime-selected: the core, regex engine and themes load only when a text preview opens.
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript"), import("shiki/themes")])
    .then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, { bundledThemes }]) => createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [bundledThemes["github-light"], bundledThemes["github-dark"]],
      langs: [],
    }));
  return highlighter;
}

export type HighlightedLine = { content: string; style: CSSProperties }[];

export async function highlightCode(text: string, languageId: string): Promise<HighlightedLine[]> {
  const core = await loadHighlighter();
  if (!core.getLoadedLanguages().includes(languageId)) {
    const info = bundledLanguagesInfo.find((language) => language.id === languageId);
    if (!info) throw new Error(`Unknown language ${languageId}`);
    await core.loadLanguage(await info.import());
  }
  const { tokens } = core.codeToTokens(text, {
    lang: languageId,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
  return tokens.map((line: ThemedToken[]) => line.map((token) => ({ content: token.content, style: (token.htmlStyle ?? {}) as CSSProperties })));
}
