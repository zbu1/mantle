import { EditorState, Plugin, PluginKey, TextSelection, Transaction } from 'prosemirror-state';
import { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { schema } from '../schema';
import { SYNTAX } from './syntax-reveal-plugin';

export interface FindQuery {
  text: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface Match {
  from: number;
  to: number;
  /** The visible text matched, for `$1`-style replacements. */
  text: string;
}

interface FindState {
  query: FindQuery | null;
  matches: Match[];
  /** Index of the current match, or -1. */
  current: number;
}

export const findKey = new PluginKey<FindState>('find');

/** The query as a global RegExp, or null when it's empty or not a valid pattern. */
export function queryRegExp(query: FindQuery): RegExp | null {
  if (!query.text) return null;
  let source = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (query.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `gu${query.matchCase ? '' : 'i'}`);
  } catch {
    return null;
  }
}

/**
 * Each textblock's visible text, with the doc position of every character:
 * revealed Markdown delimiters, a revealed `## ` and hidden `%%comments%%`
 * aren't part of it.
 */
function visibleText(block: PMNode, start: number): { text: string; positions: number[] } {
  let text = '';
  const positions: number[] = [];
  block.forEach((node, offset) => {
    if (!node.isText) return;
    const marks = node.marks;
    if (schema.marks['md_prefix'].isInSet(marks) || schema.marks['comment'].isInSet(marks)) return;
    const pos = start + offset;
    const skip = new Set<number>();
    if (schema.marks['md_raw'].isInSet(marks)) {
      for (const m of node.text!.matchAll(SYNTAX)) for (let i = 0; i < m[0].length; i++) skip.add(m.index + i);
    }
    [...node.text!].forEach((char, i) => {
      if (skip.has(i)) return;
      text += char;
      positions.push(pos + i);
    });
  });
  return { text, positions };
}

export function findMatches(doc: PMNode, query: FindQuery | null): Match[] {
  const regex = query && queryRegExp(query);
  if (!regex) return [];
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const { text, positions } = visibleText(node, pos + 1);
    for (const m of text.matchAll(regex)) {
      if (!m[0]) continue;
      matches.push({ from: positions[m.index], to: positions[m.index + m[0].length - 1] + 1, text: m[0] });
    }
    return false;
  });
  return matches;
}

/** The first match at or after `pos`, wrapping around. */
function matchFrom(matches: Match[], pos: number): number {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => m.from >= pos);
  return i < 0 ? 0 : i;
}

/**
 * In-note find: highlights every match of the query with decorations and
 * tracks the current one. The find bar drives it through the functions below.
 */
export function findPlugin(): Plugin<FindState> {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => ({ query: null, matches: [], current: -1 }),
      apply(tr, value, _old, state) {
        const query = tr.getMeta(findKey) as FindQuery | null | undefined;
        if (query === undefined && !tr.docChanged && !tr.selectionSet) return value;
        const next = query === undefined ? value.query : query;
        const matches = query === undefined && !tr.docChanged ? value.matches : findMatches(state.doc, next);
        // The match the selection sits on is the current one; otherwise the next after it.
        const { from } = state.selection;
        const on = matches.findIndex((m) => m.from === from && m.to === state.selection.to);
        return { query: next, matches, current: on >= 0 ? on : matchFrom(matches, from) };
      },
    },
    props: {
      decorations(state) {
        const { matches, current } = findKey.getState(state)!;
        if (!matches.length) return null;
        return DecorationSet.create(
          state.doc,
          matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? 'find-match find-match-current' : 'find-match' })),
        );
      },
    },
  });
}

export function setFindQuery(view: EditorView, query: FindQuery | null): void {
  view.dispatch(view.state.tr.setMeta(findKey, query));
}

export function findStatus(state: EditorState): { current: number; total: number } {
  const { matches, current } = findKey.getState(state)!;
  return { current: current + 1, total: matches.length };
}

function select(tr: Transaction, match: Match): Transaction {
  return tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)).scrollIntoView();
}

/** Selects the next (or previous) match, wrapping around. */
export function findNext(view: EditorView, backward = false): void {
  const { matches, current } = findKey.getState(view.state)!;
  if (!matches.length) return;
  const { from, to } = view.state.selection;
  const onCurrent = matches[current]?.from === from && matches[current]?.to === to;
  // The current match isn't selected yet (just typed the query): go to it first.
  const index = !onCurrent && !backward ? current : (current + (backward ? -1 : 1) + matches.length) % matches.length;
  view.dispatch(select(view.state.tr, matches[index]));
}

/** What `match` is replaced with: `replacement`, with `$1`-style groups filled in for a regex query. */
function replacementFor(query: FindQuery, match: Match, replacement: string): string {
  if (!query.regex) return replacement;
  const regex = queryRegExp(query)!;
  return match.text.replace(new RegExp(regex.source, regex.flags.replace('g', '')), replacement);
}

/** Replaces the current match, keeping its marks, and moves on to the next; one undo step. */
export function replaceCurrent(view: EditorView, replacement: string): void {
  const { query, matches, current } = findKey.getState(view.state)!;
  const match = matches[current];
  if (!query || !match) return;
  const text = replacementFor(query, match, replacement);
  const tr = view.state.tr.insertText(text, match.from, match.to);
  const next = findMatches(tr.doc, query);
  const after = matchFrom(next, match.from + text.length);
  view.dispatch(after >= 0 ? select(tr, next[after]) : tr);
}

/** Replaces every match, keeping each one's marks; one undo step. */
export function replaceAll(view: EditorView, replacement: string): void {
  const { query, matches } = findKey.getState(view.state)!;
  if (!query || !matches.length) return;
  const tr = view.state.tr;
  for (const match of [...matches].reverse()) tr.insertText(replacementFor(query, match, replacement), match.from, match.to);
  view.dispatch(tr);
}
