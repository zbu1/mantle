import { EditorState, Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { toggleMark, setBlockType, wrapIn } from 'prosemirror-commands';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import { schema } from './schema';

export function isMarkActive(state: EditorState, markName: string): boolean {
  const markType = schema.marks[markName];
  if (!markType) return false;
  const { from, $from, to, empty } = state.selection;
  if (empty) {
    return !!markType.isInSet(state.storedMarks || $from.marks());
  } else {
    return state.doc.rangeHasMark(from, to, markType);
  }
}

export function getMarkAttributes(state: EditorState, markName: string): Record<string, any> {
  const markType = schema.marks[markName];
  if (!markType) return {};
  const { from, $from, to, empty } = state.selection;
  if (empty) {
    const mark = markType.isInSet(state.storedMarks || $from.marks());
    return mark ? mark.attrs : {};
  } else {
    let attrs = {};
    state.doc.nodesBetween(from, to, (node) => {
      const mark = markType.isInSet(node.marks);
      if (mark) attrs = mark.attrs;
    });
    return attrs;
  }
}

export function executeCommand(view: EditorView, command: Command): boolean {
  return command(view.state, view.dispatch, view);
}

export function toggleBold(view: EditorView): boolean {
  return executeCommand(view, toggleMark(schema.marks['strong']));
}

export function toggleItalic(view: EditorView): boolean {
  return executeCommand(view, toggleMark(schema.marks['em']));
}

export function toggleStrike(view: EditorView): boolean {
  return executeCommand(view, toggleMark(schema.marks['strike']));
}

export function toggleCode(view: EditorView): boolean {
  return executeCommand(view, toggleMark(schema.marks['code']));
}

export function setLink(view: EditorView, href: string): boolean {
  const markType = schema.marks['link'];
  if (!markType) return false;
  const { from, to } = view.state.selection;
  if (from === to) return false;
  const tr = view.state.tr.addMark(from, to, markType.create({ href }));
  view.dispatch(tr);
  return true;
}

export function unsetLink(view: EditorView): boolean {
  const markType = schema.marks['link'];
  if (!markType) return false;
  const { from, to } = view.state.selection;
  const tr = view.state.tr.removeMark(from, to, markType);
  view.dispatch(tr);
  return true;
}

export function setHeading(view: EditorView, level: number): boolean {
  const { $from } = view.state.selection;
  const currentLevel = $from.parent.type === schema.nodes['heading'] ? $from.parent.attrs['level'] : 0;
  if (currentLevel === level) {
    return executeCommand(view, setBlockType(schema.nodes['paragraph']));
  } else {
    return executeCommand(view, setBlockType(schema.nodes['heading'], { level }));
  }
}

export function toggleBulletList(view: EditorView): boolean {
  const { $from, $to } = view.state.selection;
  const range = $from.blockRange($to);
  if (range && range.parent.type === schema.nodes['bullet_list']) {
    return executeCommand(view, liftListItem(schema.nodes['list_item']));
  }
  return executeCommand(view, wrapInList(schema.nodes['bullet_list']));
}

export function toggleOrderedList(view: EditorView): boolean {
  const { $from, $to } = view.state.selection;
  const range = $from.blockRange($to);
  if (range && range.parent.type === schema.nodes['ordered_list']) {
    return executeCommand(view, liftListItem(schema.nodes['list_item']));
  }
  return executeCommand(view, wrapInList(schema.nodes['ordered_list']));
}

export function toggleTaskList(view: EditorView): boolean {
  const { $from, $to } = view.state.selection;
  const range = $from.blockRange($to);
  if (range && range.parent.type === schema.nodes['task_list']) {
    return executeCommand(view, liftListItem(schema.nodes['task_item']));
  }
  return executeCommand(view, wrapInList(schema.nodes['task_list']));
}

export function toggleBlockquote(view: EditorView): boolean {
  const { $from } = view.state.selection;
  if ($from.parent.type === schema.nodes['blockquote'] || $from.depth > 1 && $from.node($from.depth - 1).type === schema.nodes['blockquote']) {
    return executeCommand(view, setBlockType(schema.nodes['paragraph']));
  }
  return executeCommand(view, wrapIn(schema.nodes['blockquote']));
}

export function toggleCodeBlock(view: EditorView): boolean {
  const { $from } = view.state.selection;
  if ($from.parent.type === schema.nodes['code_block']) {
    return executeCommand(view, setBlockType(schema.nodes['paragraph']));
  }
  return executeCommand(view, setBlockType(schema.nodes['code_block']));
}

export function insertHorizontalRule(view: EditorView): boolean {
  const hr = schema.nodes['horizontal_rule'].create();
  const tr = view.state.tr.replaceSelectionWith(hr);
  view.dispatch(tr);
  return true;
}
