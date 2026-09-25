export interface Searchable {
  label: string;
  keywords?: string[];
  disabled?: boolean;
}

function subsequence(text: string, query: string) {
  let at = -1;
  for (const char of query) {
    at = text.indexOf(char, at + 1);
    if (at === -1) return false;
  }
  return true;
}

export function matches(option: Searchable, query: string) {
  if (option.disabled) return false;
  if (subsequence(option.label.toLowerCase(), query)) return true;
  return option.keywords?.some((keyword) => keyword.toLowerCase().includes(query)) ?? false;
}

export function rank(label: string, query: string) {
  const name = label.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return 3;
}

/** Subsequence match on the label or substring on keywords; exact and prefix hits sort first. */
export function search<T extends Searchable>(options: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options
    .filter((option) => matches(option, needle))
    .map((option, index) => ({ option, index, score: rank(option.label, needle) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ option }) => option);
}
