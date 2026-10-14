import hljs from 'highlight.js/lib/common';

/** A language highlight.js's `common` bundle can highlight. */
export interface CodeLanguage {
  /** What the picker writes into the fence, e.g. `typescript`. */
  id: string;
  /** Display name, e.g. `TypeScript`. */
  name: string;
  aliases: readonly string[];
}

export const CODE_LANGUAGES: readonly CodeLanguage[] = hljs
  .listLanguages()
  .map((id) => {
    const lang = hljs.getLanguage(id)!;
    return { id, name: lang.name ?? id, aliases: lang.aliases ?? [] };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/** The language word of a fence's info string: `ts` for ```` ```ts title="x" ````. */
export function fenceLanguage(params: string): string {
  return params.trim().split(/\s+/)[0] ?? '';
}

/** The id of the fence's language in `CODE_LANGUAGES` (aliases resolve), or null when it has none or isn't known. */
export function languageId(params: string): string | null {
  const lang = fenceLanguage(params).toLowerCase();
  return (lang && CODE_LANGUAGES.find((l) => l.id === lang || l.aliases.includes(lang))?.id) || null;
}

/** The display name of a fence's language (aliases resolve), or null when it has none or highlight.js doesn't know it. */
export function languageName(params: string): string | null {
  const lang = fenceLanguage(params);
  return (lang && hljs.getLanguage(lang)?.name) || null;
}

/** Languages whose name, id or an alias contains `query` (ignoring case); all of them for a blank query. */
export function matchLanguages(query: string): CodeLanguage[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...CODE_LANGUAGES];
  return CODE_LANGUAGES.filter(
    (lang) => lang.name.toLowerCase().includes(q) || lang.id.includes(q) || lang.aliases.some((alias) => alias.includes(q)),
  );
}

/** A highlighted stretch of a code block's text: offsets into it, and the highlight.js classes to put on it. */
export interface CodeToken {
  from: number;
  to: number;
  className: string;
}

/**
 * Highlights `code` as the fence language in `params`; no tokens for a block
 * without a known language (no auto-detection). highlight.js only hands out
 * HTML publicly, so its spans are walked back into offsets.
 */
export function highlightCode(code: string, params: string): CodeToken[] {
  const lang = fenceLanguage(params);
  if (!code || !lang || !hljs.getLanguage(lang)) return [];
  const template = document.createElement('template');
  template.innerHTML = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;

  const tokens: CodeToken[] = [];
  let offset = 0;
  const visit = (node: Node, classes: string): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent!.length;
      if (classes) tokens.push({ from: offset, to: offset + length, className: classes });
      offset += length;
      return;
    }
    // Nested spans (e.g. a `hljs-subst` in a string) carry their parents' classes too; CSS order picks the winner.
    const own = node instanceof Element ? node.className : '';
    const inner = own ? (classes ? `${classes} ${own}` : own) : classes;
    node.childNodes.forEach((child) => visit(child, inner));
  };
  visit(template.content, '');
  return tokens;
}
