import { Plugin } from 'prosemirror-state';
import { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { schema } from '../schema';

const FOOTNOTE = /\[\^([^\]\s]+)\]/g;
/** A definition: `[^label]: text` starting a paragraph. */
const DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]*/;

export interface Footnotes {
  /** Each definition's text, by label. */
  definitions: Map<string, string>;
  refs: { from: number; to: number; label: string }[];
  defs: { from: number; to: number; label: string }[];
}

/** The footnote references and definitions in `doc`, outside code. */
export function findFootnotes(doc: PMNode): Footnotes {
  const found: Footnotes = { definitions: new Map(), refs: [], defs: [] };
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes['code_block']) return false;
    if (!node.isTextblock) return true;
    const text = node.textContent;
    const def = DEFINITION.exec(text);
    if (def && node.firstChild?.isText) {
      found.defs.push({ from: pos + 1, to: pos + 1 + def[0].length, label: def[1] });
      found.definitions.set(def[1], text.slice(def[0].length).split('\n')[0]);
    }
    node.forEach((child, offset) => {
      if (!child.isText || child.marks.some((mark) => mark.type === schema.marks['code'])) return;
      for (const match of child.text!.matchAll(FOOTNOTE)) {
        const from = pos + 1 + offset + match.index;
        if (found.defs.some((d) => d.from === from)) continue;
        found.refs.push({ from, to: from + match[0].length, label: match[1] });
      }
    });
    return false;
  });
  return found;
}

/**
 * Footnotes: `[^1]` references show as small superscript labels that show
 * their definition on hover, and `[^1]: …` definitions get their label set
 * apart. Display only (decorations); the text saves as written.
 */
export function footnotePlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const { definitions, refs, defs } = findFootnotes(state.doc);
        return DecorationSet.create(state.doc, [
          ...refs.map(({ from, to, label }) =>
            Decoration.inline(from, to, {
              class: definitions.has(label) ? 'footnote-ref' : 'footnote-ref footnote-missing',
              title: definitions.get(label) ?? `No footnote [^${label}]: defined`,
            }),
          ),
          ...defs.map(({ from, to }) => Decoration.inline(from, to, { class: 'footnote-def' })),
        ]);
      },
    },
  });
}
