import { Plugin, TextSelection, Transaction } from 'prosemirror-state';
import { Node as PMNode, Slice } from 'prosemirror-model';
import { EditorView } from 'prosemirror-view';
import { continuesList, serializeMarkdown } from '../markdown-converter';
import { schema } from '../schema';

const LISTS = [schema.nodes['bullet_list'], schema.nodes['ordered_list'], schema.nodes['task_list']];
const ITEMS = [schema.nodes['list_item'], schema.nodes['task_item']];

/** The list item whose marker (or the gutter left of it) `event` pressed, as its `<li>`. */
function markerItem(event: MouseEvent): HTMLElement | null {
  const target = event.target as HTMLElement;
  let li: Element | undefined;
  if (target.tagName === 'LI') li = target;
  else if (target.tagName === 'UL' || target.tagName === 'OL') {
    li = [...target.children].find((child) => {
      const box = child.getBoundingClientRect();
      return child.tagName === 'LI' && event.clientY >= box.top && event.clientY < box.bottom;
    });
  }
  const content = li?.firstElementChild;
  return li && content && event.clientX < content.getBoundingClientRect().left ? (li as HTMLElement) : null;
}

/** Whether `$from` sits at the very start of a list item, and the selection runs past its first line. */
function startsAtItem(view: EditorView): number | null {
  const { $from, to } = view.state.selection;
  const depth = $from.depth - 1;
  if (depth < 1 || $from.parentOffset !== 0 || $from.index(depth) !== 0 || to <= $from.end()) return null;
  return ITEMS.includes($from.node(depth).type) ? depth : null;
}

/** Whether `slice` holds a list and more than one line, i.e. reads as list items rather than a bit of text. */
function isListCopy(slice: Slice): boolean {
  let list = false;
  let lines = 0;
  slice.content.descendants((node: PMNode) => {
    list ||= LISTS.includes(node.type);
    if (node.isTextblock) lines++;
    return !node.isTextblock;
  });
  return list && lines > 1;
}

/** Numbers each numbered list that continues another (a run of checkbox and plain items) on from it. */
function renumber(tr: Transaction, node: PMNode, pos: number): boolean {
  if (node.isTextblock) return false;
  let next = 0;
  node.forEach((child, offset, index) => {
    const continues = continuesList(node, index) && child.attrs['order'] != null;
    if (continues && child.attrs['order'] !== next) tr.setNodeMarkup(pos + 1 + offset, null, { ...child.attrs, order: next });
    next = (continues ? next : child.attrs['order']) + child.childCount;
  });
  return true;
}

/**
 * List markers: pressing on (or left of) a bullet or number puts the cursor
 * at the start of that item, and dragging from there selects whole items. A
 * selection that starts at an item's start copies the item itself, marker
 * and all, and copied lists reach other apps as Markdown. Numbered lists
 * split by checkboxes keep counting on.
 */
export function listMarkerPlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, _oldState, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const tr = state.tr;
      renumber(tr, state.doc, -1);
      state.doc.descendants((node, pos) => renumber(tr, node, pos));
      return tr.docChanged ? tr : null;
    },
    props: {
      handleDOMEvents: {
        mousedown: (view, event) => {
          if (event.button !== 0 || event.shiftKey) return false;
          const li = markerItem(event);
          if (!li) return false;
          event.preventDefault();
          const start = view.posAtDOM(li, 0) + 1;
          view.focus();
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
          const move = (e: MouseEvent) => {
            const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
            if (!hit) return;
            const { doc, selection } = view.state;
            view.dispatch(view.state.tr.setSelection(TextSelection.between(selection.$anchor, doc.resolve(hit.pos))));
          };
          const stop = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', stop);
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', stop);
          return true;
        },
      },
      transformCopied: (slice, view) => {
        const depth = startsAtItem(view);
        if (depth === null) return slice;
        // From just before the item, with its list whole at the start.
        const { $from, to } = view.state.selection;
        const whole = view.state.doc.slice($from.before(depth), to, true);
        return new Slice(whole.content, whole.openStart - 1, whole.openEnd);
      },
      clipboardTextSerializer: (slice) => {
        const text = slice.content.textBetween(0, slice.content.size, '\n\n');
        if (!isListCopy(slice)) return text;
        try {
          return serializeMarkdown(schema.node('doc', null, slice.content));
        } catch {
          return text;
        }
      },
    },
  });
}
