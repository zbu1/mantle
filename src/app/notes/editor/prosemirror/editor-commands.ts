import { Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import { schema } from './schema';

export function executeCommand(view: EditorView, command: Command): boolean {
  return command(view.state, view.dispatch, view);
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
  const quoted = $from.depth > 1 && $from.node(-1).type === schema.nodes['blockquote'];
  return executeCommand(view, quoted ? lift : wrapIn(schema.nodes['blockquote']));
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

/** Whether the selection sits in revealed Markdown, where marks can't go and delimiters are typed instead. */
function inRawMarkdown(view: EditorView): boolean {
  const { from, to, $from } = view.state.selection;
  const raw = schema.marks['md_raw'];
  return view.state.doc.rangeHasMark(from, to, raw) || !!raw.isInSet($from.marks());
}

/** Wraps the selection in raw Markdown, which parses once the cursor leaves. */
function wrapInRaw(view: EditorView, open: string, close: string): void {
  const { from, to } = view.state.selection;
  const raw = [schema.marks['md_raw'].create()];
  view.dispatch(view.state.tr.insert(to, schema.text(close, raw)).insert(from, schema.text(open, raw)));
}

/** Bold, italic, etc. on the selection: toggles the mark, or in revealed Markdown wraps it in `delimiter`. */
export function formatSelection(view: EditorView, mark: string, delimiter: string): void {
  if (inRawMarkdown(view)) wrapInRaw(view, delimiter, delimiter);
  else toggleMark(schema.marks[mark])(view.state, view.dispatch);
}

/** Links the selection to `href`; with nothing selected, inserts `href` itself as the link text. */
export function linkSelection(view: EditorView, href: string): void {
  if (inRawMarkdown(view)) return wrapInRaw(view, '[', `](${href})`);
  const { from, to, empty } = view.state.selection;
  const link = schema.marks['link'].create({ href });
  const tr = empty ? view.state.tr.insert(from, schema.text(href, [link])) : view.state.tr.addMark(from, to, link);
  view.dispatch(tr);
}

/** Pastes the clipboard as literal text, without reading it as Markdown. */
export function pastePlainText(view: EditorView): void {
  void navigator.clipboard.readText().then((text) => text && view.dispatch(view.state.tr.insertText(text)));
}
