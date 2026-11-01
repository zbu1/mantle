import { invoke } from '@tauri-apps/api/core';
import { Node } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';

export const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const URL = /(?:https?:\/\/|www\.)\S+/gu;
const BATCH = 400;
const DEBOUNCE_MS = 300;

/** Words already asked about, across every editor: true when misspelled. */
const verdicts = new Map<string, boolean>();

/** Words that are never checked: capitalized, or with digits. */
const skipped = (word: string) => /^\p{Lu}/u.test(word);

const clean = (word: string) => word.replace(/’/g, "'");

export const spellcheckKey = new PluginKey<DecorationSet>('spellcheck');

/** Marks a word as added to the dictionary, so every editor stops underlining it. */
export function forgetMisspelling(word: string): void {
  verdicts.set(clean(word), false);
}

/** The words of `doc` worth checking, with their positions. */
function wordsIn(doc: Node, unknown?: Set<string>): { from: number; to: number; word: string }[] {
  const found: { from: number; to: number; word: string }[] = [];
  doc.descendants((block, start) => {
    if (!block.isTextblock) return !block.type.spec.code;
    if (block.type.spec.code) return false;
    // One character per position; code, links and atoms become a break so
    // words don't run across them.
    let text = '';
    block.forEach((child) => {
      const skip = !child.isText || child.marks.some((m) => m.type.spec.code || m.type.name === 'wikilink');
      text += skip ? '\u{fffc}'.repeat(child.nodeSize) : child.text;
    });
    for (const url of text.matchAll(URL)) text = text.slice(0, url.index) + '\u{fffc}'.repeat(url[0].length) + text.slice(url.index + url[0].length);
    for (const match of text.matchAll(WORD)) {
      const word = clean(match[0]);
      const before = text[match.index - 1];
      if (skipped(word) || before === '#' || /\d/.test(before ?? '') || /\d/.test(text[match.index + match[0].length] ?? '')) continue;
      const from = start + 1 + match.index;
      found.push({ from, to: from + match[0].length, word });
      if (!verdicts.has(word)) unknown?.add(word);
    }
    return false;
  });
  return found;
}

/** Squiggles under misspelled words, checked in Rust in debounced batches. */
export function spellcheckPlugin(enabled: () => boolean): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: spellcheckKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set, _old, state) {
        if (!enabled()) return DecorationSet.empty;
        if (!tr.docChanged && !tr.getMeta(spellcheckKey) && set !== DecorationSet.empty) return set;
        // ponytail: rescans the whole note per change; scan only the edited blocks if huge notes lag.
        return DecorationSet.create(
          state.doc,
          wordsIn(state.doc)
            .filter((w) => verdicts.get(w.word))
            .map((w) => Decoration.inline(w.from, w.to, { class: 'spell-error' })),
        );
      },
    },
    props: {
      decorations: (state) => spellcheckKey.getState(state),
      attributes: { spellcheck: 'false' },
    },
    view(view: EditorView) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let alive = true;
      const flush = async () => {
        const unknown = new Set<string>();
        wordsIn(view.state.doc, unknown);
        const words = [...unknown].slice(0, BATCH);
        if (!words.length) return;
        try {
          const wrong = new Set(await invoke<string[]>('spell_check', { words }));
          for (const word of words) verdicts.set(word, wrong.has(word));
        } catch {
          // No checker: leave the words unchecked and unmarked.
          for (const word of words) verdicts.set(word, false);
        }
        if (!alive) return;
        view.dispatch(view.state.tr.setMeta(spellcheckKey, true).setMeta('addToHistory', false));
        if (unknown.size > BATCH) void flush();
      };
      const schedule = () => {
        clearTimeout(timer);
        if (enabled()) timer = setTimeout(() => void flush(), DEBOUNCE_MS);
      };
      schedule();
      return {
        update: schedule,
        destroy() {
          alive = false;
          clearTimeout(timer);
        },
      };
    },
  });
}
