import { Command, EditorState, TextSelection } from 'prosemirror-state';
import { Node as PMNode } from 'prosemirror-model';
import { liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { compose } from '../editor-commands';
import { schema } from '../schema';

const isItem = (node: PMNode) => node.type === schema.nodes['list_item'] || node.type === schema.nodes['task_item'];

/**
 * The list items whose first line the selection touches, as a position inside
 * that line, in document order. With `topmost`, an item inside another
 * selected item is left out (it moves with it).
 */
function selectedItems(state: EditorState, topmost: boolean): number[] {
  const { from, to } = state.selection;
  const found: { pos: number; end: number }[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!isItem(node) || !node.firstChild) return;
    const lineEnd = pos + 1 + node.firstChild.nodeSize;
    if (lineEnd < from || pos + 1 > to) return;
    if (topmost && found.some((outer) => pos < outer.end)) return;
    found.push({ pos, end: pos + node.nodeSize });
  });
  return found.map(({ pos }) => pos + 2);
}

/**
 * Tab / Shift-Tab in a list: every selected item moves one level, and only
 * that item. Indenting leaves its children where they were (now its next
 * siblings); outdenting brings them up with it, and the items after it become
 * its children. Claims the key anywhere in a list, so focus stays in the
 * editor even when nothing can move (a first item has nothing to nest under).
 */
export function indentListItems(outdent: boolean): Command {
  return (state, dispatch) => {
    const lines = selectedItems(state, outdent);
    if (lines.length === 0) return false;
    if (!dispatch) return true;

    const composed = compose(state);
    const { tr, run } = composed;
    const original = state.selection;
    for (const line of lines) {
      const pos = tr.mapping.map(line);
      composed.select(pos);
      const $pos = composed.state.doc.resolve(pos);
      const item = $pos.node(-1);
      if (outdent) {
        run(liftListItem(item.type));
        continue;
      }
      if (!run(sinkListItem(item.type))) continue;
      // Its children went down with it: bring them back up beside it.
      const $moved = composed.state.doc.resolve(tr.mapping.map(line));
      const moved = $moved.node(-1);
      const list = $moved.node(-2);
      const children = moved.lastChild;
      if (moved.childCount < 2 || children?.type !== list.type) continue;
      const end = $moved.end(-1);
      const start = end - children.nodeSize;
      composed.select(start + 3);
      const $last = composed.state.doc.resolve(end - 2);
      run((s, d) => (d?.(s.tr.setSelection(TextSelection.between(s.selection.$from, $last, -1))), true));
      run(liftListItem(item.type));
    }
    if (!tr.docChanged) return true;
    dispatch(tr.setSelection(original.map(tr.doc, tr.mapping)).scrollIntoView());
    return true;
  };
}
