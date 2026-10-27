import { EditorState, Plugin, PluginKey } from 'prosemirror-state';
import { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { schema } from '../schema';

/** `[!type]`, `[!type]-` (folded) or `[!type]+` (foldable) at the start of a quote. */
const MARKER = /^\[!([\w-]+)\]([+-]?)[ \t]*/;

/** Each callout type's color, by the theme token family it borrows. */
const COLORS: Record<string, string> = {
  tip: 'success', hint: 'success', important: 'success', success: 'success', check: 'success', done: 'success',
  question: 'warning', help: 'warning', faq: 'warning', warning: 'warning', caution: 'warning', attention: 'warning',
  failure: 'danger', fail: 'danger', missing: 'danger', danger: 'danger', error: 'danger', bug: 'danger',
  example: 'example', quote: 'quote', cite: 'quote',
};

export interface Callout {
  /** The blockquote's position. */
  pos: number;
  type: string;
  fold: '' | '+' | '-';
  markerFrom: number;
  markerTo: number;
  /** Where the title line ends: the first line break in the first paragraph, or that paragraph's end. */
  titleTo: number;
  /** The end of the first paragraph's content. */
  paragraphTo: number;
}

/** Every callout in `doc`: a quote whose first paragraph starts with `[!type]`. */
export function findCallouts(doc: PMNode): Callout[] {
  const out: Callout[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== schema.nodes['blockquote']) return true;
    const first = node.firstChild;
    const match = first?.type === schema.nodes['paragraph'] && first.firstChild?.isText ? MARKER.exec(first.firstChild.text!) : null;
    if (!first || !match) return true;
    const markerFrom = pos + 2;
    let titleTo = markerFrom + first.content.size;
    first.forEach((child, offset) => {
      if (child.type === schema.nodes['hard_break']) titleTo = Math.min(titleTo, markerFrom + offset);
    });
    out.push({
      pos,
      type: match[1].toLowerCase(),
      fold: match[2] as Callout['fold'],
      markerFrom,
      markerTo: markerFrom + match[0].length,
      titleTo,
      paragraphTo: markerFrom + first.content.size,
    });
    return true;
  });
  return out;
}

/** Callouts whose fold differs from what their marker says, by position. */
export const calloutFoldKey = new PluginKey<number[]>('callout-fold');

function isFolded(callout: Callout, toggled: readonly number[]): boolean {
  return callout.fold !== '' && (callout.fold === '-') !== toggled.includes(callout.pos);
}

/** Whether `at` is in what folding the callout hides: past its title line. */
function inBody(doc: PMNode, callout: Callout, at: number): boolean {
  return at > callout.titleTo && at < callout.pos + doc.nodeAt(callout.pos)!.nodeSize;
}

/** The callout's icon, and its type as the title when it has none. */
function label(type: string, empty: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = 'callout-label';
  span.contentEditable = 'false';
  if (empty) span.textContent = type.charAt(0).toUpperCase() + type.slice(1);
  return span;
}

function chevron(folded: boolean, toggle: () => void): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.contentEditable = 'false';
  button.className = `callout-fold${folded ? ' callout-fold-folded' : ''}`;
  button.title = folded ? 'Expand' : 'Collapse';
  button.setAttribute('aria-expanded', String(!folded));
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    toggle();
  });
  return button;
}

function decorations(state: EditorState): DecorationSet {
  const toggled = calloutFoldKey.getState(state)!;
  const head = state.selection.head;
  const out: Decoration[] = [];
  for (const callout of findCallouts(state.doc)) {
    const node = state.doc.nodeAt(callout.pos)!;
    const folded = isFolded(callout, toggled);
    const toggle = (view: EditorView) => view.dispatch(view.state.tr.setMeta(calloutFoldKey, callout.pos));
    out.push(
      Decoration.node(callout.pos, callout.pos + node.nodeSize, {
        class: `callout callout-${COLORS[callout.type] ?? 'note'}`,
        'data-callout': callout.type,
      }),
    );
    // The marker shows as written while the cursor is on the title line.
    const editing = head >= callout.markerFrom && head <= callout.titleTo;
    const empty = callout.markerTo >= callout.titleTo;
    if (editing) {
      out.push(Decoration.inline(callout.markerFrom, callout.markerTo, { class: 'callout-marker' }));
    } else {
      out.push(
        Decoration.widget(callout.markerFrom, () => label(callout.type, empty), {
          side: -1,
          key: `callout-${callout.type}-${empty}`,
        }),
        Decoration.inline(callout.markerFrom, callout.markerTo, { style: 'display: none' }),
      );
    }
    if (!empty) out.push(Decoration.inline(callout.markerTo, callout.titleTo, { class: 'callout-title' }));
    if (callout.fold) {
      out.push(
        Decoration.widget(callout.titleTo, (view) => chevron(folded, () => toggle(view)), {
          side: 1,
          ignoreSelection: true,
          key: `callout-fold-${callout.pos}-${folded}`,
        }),
      );
    }
    if (!folded) continue;
    if (callout.paragraphTo > callout.titleTo) {
      out.push(Decoration.inline(callout.titleTo, callout.paragraphTo, { style: 'display: none' }));
    }
    node.forEach((child, offset, index) => {
      const at = callout.pos + 1 + offset;
      if (index > 0) out.push(Decoration.node(at, at + child.nodeSize, { style: 'display: none' }));
    });
  }
  return DecorationSet.create(state.doc, out);
}

/**
 * Callouts: a quote starting `[!type] Title` is drawn as a colored box with
 * its title, showing the marker as written while the cursor is on the title
 * line. `[!type]-` starts folded and `[!type]+` unfolded; folding is a display
 * state (decorations), so the file doesn't change. A folded callout unfolds
 * when the cursor moves into it.
 */
export function calloutPlugin(): Plugin<number[]> {
  return new Plugin<number[]>({
    key: calloutFoldKey,
    state: {
      init: () => [],
      apply(tr, toggled, _old, state) {
        let next = toggled
          .map((pos) => tr.mapping.mapResult(pos, 1))
          .filter((mapped) => !mapped.deleted)
          .map((mapped) => mapped.pos);
        const meta = tr.getMeta(calloutFoldKey) as number | undefined;
        if (meta !== undefined) next = next.includes(meta) ? next.filter((p) => p !== meta) : [...next, meta];
        if (tr.selectionSet || tr.docChanged) {
          const head = state.selection.head;
          for (const callout of findCallouts(state.doc)) {
            if (isFolded(callout, next) && inBody(state.doc, callout, head)) {
              next = next.includes(callout.pos) ? next.filter((p) => p !== callout.pos) : [...next, callout.pos];
            }
          }
        }
        return next.length === toggled.length && next.every((pos, i) => pos === toggled[i]) ? toggled : next;
      },
    },
    props: { decorations },
  });
}
