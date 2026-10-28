import { Command, EditorState, Plugin, PluginKey, TextSelection, Transaction } from 'prosemirror-state';
import { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { schema } from '../schema';

/** A folded top-level heading, and where its fold stops when that's before its section ends (see `enterAfterFold`). */
type Fold = { pos: number; end: number | null };

/** The folded top-level headings. */
export const headingFoldKey = new PluginKey<Fold[]>('heading-fold');

type FoldMeta = { toggle: number } | { set: number[] } | { end: Fold };

/** Positions of the doc's top-level headings, in order. */
function headings(doc: PMNode): number[] {
  const out: number[] = [];
  doc.forEach((node, pos) => node.type === schema.nodes['heading'] && out.push(pos));
  return out;
}

/** Where the section under the heading at `pos` ends: the next heading of the same or a higher level, or the doc's end. */
function sectionEnd(doc: PMNode, pos: number): number {
  const level = doc.nodeAt(pos)!.attrs['level'];
  let end = doc.content.size;
  let found = false;
  doc.forEach((node, at) => {
    if (found || at <= pos) return;
    if (node.type === schema.nodes['heading'] && node.attrs['level'] <= level) {
      end = at;
      found = true;
    }
  });
  return end;
}

/** Where `fold` stops hiding. */
function foldEnd(doc: PMNode, fold: Fold): number {
  return Math.min(fold.end ?? Infinity, sectionEnd(doc, fold.pos));
}

function inSection(doc: PMNode, pos: number, at: number, end = sectionEnd(doc, pos)): boolean {
  return at > pos + doc.nodeAt(pos)!.nodeSize && at < end;
}

/** The folded headings, as indexes among the top-level headings. */
export function foldedHeadings(state: EditorState): number[] {
  const all = headings(state.doc);
  return headingFoldKey
    .getState(state)!
    .map((fold) => all.indexOf(fold.pos))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
}

/** Folds exactly the headings at these indexes among the top-level headings, taking the cursor out of what they hide. */
export function setFoldedHeadings(tr: Transaction, indexes: number[]): Transaction {
  const all = headings(tr.doc);
  const set = indexes.map((i) => all[i]).filter((pos) => pos !== undefined);
  const hiding = set.find((pos) => inSection(tr.doc, pos, tr.selection.head));
  if (hiding !== undefined) tr.setSelection(TextSelection.create(tr.doc, hiding + tr.doc.nodeAt(hiding)!.nodeSize - 1));
  return tr.setMeta(headingFoldKey, { set } satisfies FoldMeta);
}

function chevron(pos: number, folded: boolean): Decoration {
  return Decoration.widget(
    pos + 1,
    (view) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.contentEditable = 'false';
      button.className = `heading-fold${folded ? ' heading-fold-folded' : ''}`;
      button.title = folded ? 'Unfold section' : 'Fold section';
      button.setAttribute('aria-expanded', String(!folded));
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const tr = view.state.tr.setMeta(headingFoldKey, { toggle: pos } satisfies FoldMeta);
        // Folding away the cursor takes it to the heading.
        if (!folded && inSection(tr.doc, pos, tr.selection.head)) {
          tr.setSelection(TextSelection.create(tr.doc, pos + tr.doc.nodeAt(pos)!.nodeSize - 1));
        }
        view.dispatch(tr);
      });
      return button;
    },
    { side: -1, ignoreSelection: true, key: `fold-${pos}-${folded}` },
  );
}

/**
 * Enter at the end of a folded heading: a new line after its section, which
 * stays folded. By Markdown's rules the line still belongs to the section, so
 * the fold remembers to stop before it.
 */
export const enterAfterFold: Command = (state, dispatch) => {
  const { $head, empty } = state.selection;
  if (!empty || $head.depth !== 1 || $head.parent.type !== schema.nodes['heading'] || $head.parentOffset < $head.parent.content.size) {
    return false;
  }
  const fold = headingFoldKey.getState(state)?.find((f) => f.pos === $head.before());
  if (!fold) return false;
  const end = foldEnd(state.doc, fold);
  const tr = state.tr.insert(end, schema.nodes['paragraph'].create());
  tr.setMeta(headingFoldKey, { end: { pos: fold.pos, end } } satisfies FoldMeta);
  dispatch?.(tr.setSelection(TextSelection.create(tr.doc, end + 1)).scrollIntoView());
  return true;
};

/**
 * Folding a heading's section: a chevron beside each top-level heading hides
 * everything up to the next heading of the same or a higher level. A display
 * state only (decorations), so the file and the undo history don't change.
 * A section unfolds as soon as the cursor moves into it.
 */
export function headingFoldPlugin(): Plugin<Fold[]> {
  return new Plugin<Fold[]>({
    key: headingFoldKey,
    state: {
      init: () => [],
      apply(tr, folded, _old, state) {
        const meta = tr.getMeta(headingFoldKey) as FoldMeta | undefined;
        let next = folded.flatMap((fold) => {
          const mapped = tr.mapping.mapResult(fold.pos, 1);
          if (mapped.deleted || state.doc.nodeAt(mapped.pos)?.type !== schema.nodes['heading']) return [];
          return [{ pos: mapped.pos, end: fold.end === null ? null : tr.mapping.map(fold.end, -1) }];
        });
        if (meta && 'set' in meta) next = meta.set.map((pos) => ({ pos, end: null }));
        if (meta && 'toggle' in meta) {
          next = next.some((f) => f.pos === meta.toggle) ? next.filter((f) => f.pos !== meta.toggle) : [...next, { pos: meta.toggle, end: null }];
        }
        if (meta && 'end' in meta) next = next.map((f) => (f.pos === meta.end.pos ? meta.end : f));
        const head = state.selection.head;
        if (tr.selectionSet) next = next.filter((f) => !inSection(state.doc, f.pos, head, foldEnd(state.doc, f)));
        const same = next.length === folded.length && next.every((f, i) => f.pos === folded[i].pos && f.end === folded[i].end);
        return same ? folded : next;
      },
    },
    props: {
      decorations(state) {
        const folded = headingFoldKey.getState(state)!;
        const decorations: Decoration[] = [];
        for (const pos of headings(state.doc)) {
          const fold = folded.find((f) => f.pos === pos);
          decorations.push(chevron(pos, !!fold));
          if (!fold) continue;
          const node = state.doc.nodeAt(pos)!;
          decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'heading-folded' }));
          const end = foldEnd(state.doc, fold);
          state.doc.nodesBetween(pos + node.nodeSize, end, (child, at) => {
            decorations.push(Decoration.node(at, at + child.nodeSize, { style: 'display: none' }));
            return false;
          });
        }
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}
