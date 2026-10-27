import { EditorState, Plugin, PluginKey, TextSelection, Transaction } from 'prosemirror-state';
import { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { schema } from '../schema';

/** Positions of the folded top-level headings. */
export const headingFoldKey = new PluginKey<number[]>('heading-fold');

type FoldMeta = { toggle: number } | { set: number[] };

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

function inSection(doc: PMNode, pos: number, at: number): boolean {
  return at > pos + doc.nodeAt(pos)!.nodeSize && at < sectionEnd(doc, pos);
}

/** The folded headings, as indexes among the top-level headings. */
export function foldedHeadings(state: EditorState): number[] {
  const all = headings(state.doc);
  return headingFoldKey
    .getState(state)!
    .map((pos) => all.indexOf(pos))
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
 * Folding a heading's section: a chevron beside each top-level heading hides
 * everything up to the next heading of the same or a higher level. A display
 * state only (decorations), so the file and the undo history don't change.
 * A section unfolds as soon as the cursor moves into it.
 */
export function headingFoldPlugin(): Plugin<number[]> {
  return new Plugin<number[]>({
    key: headingFoldKey,
    state: {
      init: () => [],
      apply(tr, folded, _old, state) {
        const meta = tr.getMeta(headingFoldKey) as FoldMeta | undefined;
        let next = folded
          .map((pos) => tr.mapping.mapResult(pos, 1))
          .filter((mapped) => !mapped.deleted && state.doc.nodeAt(mapped.pos)?.type === schema.nodes['heading'])
          .map((mapped) => mapped.pos);
        if (meta && 'set' in meta) next = meta.set;
        if (meta && 'toggle' in meta) next = next.includes(meta.toggle) ? next.filter((p) => p !== meta.toggle) : [...next, meta.toggle];
        const head = state.selection.head;
        if (tr.selectionSet) next = next.filter((pos) => !inSection(state.doc, pos, head));
        return next.length === folded.length && next.every((pos, i) => pos === folded[i]) ? folded : next;
      },
    },
    props: {
      decorations(state) {
        const folded = headingFoldKey.getState(state)!;
        const decorations: Decoration[] = [];
        for (const pos of headings(state.doc)) {
          const isFolded = folded.includes(pos);
          decorations.push(chevron(pos, isFolded));
          if (!isFolded) continue;
          const node = state.doc.nodeAt(pos)!;
          decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'heading-folded' }));
          const end = sectionEnd(state.doc, pos);
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
