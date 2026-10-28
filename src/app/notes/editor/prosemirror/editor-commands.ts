import { Command, EditorState, Selection, TextSelection, Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { Fragment, MarkType, Node as PMNode, NodeType } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import { schema } from './schema';
import { codeAsParagraph, parseMarkdown, serializeMarkdown } from './markdown-converter';

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

export type BlockKind = 'paragraph' | 'h1' | 'h2' | 'h3' | 'bullet_list' | 'ordered_list' | 'task_list' | 'blockquote' | 'code_block';

const LISTS = ['bullet_list', 'ordered_list', 'task_list'];
const isList = (type: NodeType) => LISTS.includes(type.name);

/**
 * "Turn into": gives the selected blocks `kind`, as one undo step. Unlike the
 * slash menu it never toggles: a block that already is `kind` stays as it is.
 * Paragraph lifts out of lists and quotes, a heading out of lists; a list
 * of another kind becomes `kind` (the selection's innermost list, at its level).
 */
export function turnInto(view: EditorView, kind: BlockKind): void {
  const composed = compose(view.state);
  const { tr, run } = composed;
  const ancestor = (test: (type: NodeType) => boolean) => {
    const { $from } = composed.state.selection;
    for (let d = $from.depth; d > 0; d--) if (test($from.node(d).type)) return d;
    return 0;
  };
  // Lifts out of every enclosing list (and quote, with `quotes`).
  const liftOut = (quotes: boolean) => {
    for (let guard = 0; guard < 100; guard++) {
      const lifted =
        (ancestor(isList) &&
          (run(liftListItem(schema.nodes['list_item'])) || run(liftListItem(schema.nodes['task_item'])))) ||
        (quotes && ancestor((type) => type === schema.nodes['blockquote']) && run(lift));
      if (!lifted) return;
    }
  };
  // The revealed `## ` / `> ` prefixes aren't text a code block should keep.
  const dropPrefixes = () => {
    const from = composed.state.selection.$from.start();
    const to = composed.state.selection.$to.end();
    const prefix = schema.marks['md_prefix'];
    const ranges: [number, number][] = [];
    composed.state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isText && prefix.isInSet(node.marks)) ranges.push([pos, pos + node.nodeSize]);
    });
    if (ranges.length) run((s, dispatch) => (dispatch?.(ranges.reverse().reduce((t, [a, b]) => t.delete(a, b), s.tr)), true));
  };

  const { $from } = composed.state.selection;
  const block = $from.parent;
  switch (kind) {
    case 'paragraph':
      liftOut(true);
      run(setBlockType(schema.nodes['paragraph']));
      break;
    case 'h1':
    case 'h2':
    case 'h3':
      liftOut(false);
      run(setBlockType(schema.nodes['heading'], { level: Number(kind[1]) }));
      break;
    case 'blockquote':
      if (!ancestor((type) => type === schema.nodes['blockquote'])) run(wrapIn(schema.nodes['blockquote']));
      break;
    case 'code_block':
      if (block.type === schema.nodes['code_block']) break;
      dropPrefixes();
      run(setBlockType(schema.nodes['code_block']));
      break;
    default: {
      const target = schema.nodes[kind];
      const depth = ancestor(isList);
      if (depth) {
        const list = $from.node(depth);
        if (list.type === target) break;
        const item = schema.nodes[kind === 'task_list' ? 'task_item' : 'list_item'];
        const listPos = $from.before(depth);
        run((s, dispatch) => {
          // Keeps what both kinds of list have (`tight`, `bullet`, `order`), so it saves as written.
          const attrs = Object.fromEntries(Object.keys(target.spec.attrs ?? {}).filter((key) => list.attrs[key] != null).map((key) => [key, list.attrs[key]]));
          const items: PMNode[] = [];
          list.forEach((child) => items.push(item.create(item === child.type ? child.attrs : null, child.content, child.marks)));
          const t = s.tr.replaceWith(listPos, listPos + list.nodeSize, target.create(attrs, items));
          dispatch?.(t);
          return true;
        });
        break;
      }
      // A list item starts with a paragraph.
      if (block.type === schema.nodes['code_block']) {
        const pos = $from.before();
        run((s, dispatch) => (dispatch?.(s.tr.replaceWith(pos, pos + block.nodeSize, codeAsParagraph(block))), true));
        composed.select(pos + 1);
      } else if (block.type !== schema.nodes['paragraph']) {
        run(setBlockType(schema.nodes['paragraph']));
      }
      run(wrapInList(target));
    }
  }
  if (tr.docChanged) view.dispatch(composed.finish().scrollIntoView());
}

/**
 * Runs commands one after another as a single transaction on `state`'s doc:
 * each sees the last one's result, on a plugin-free copy so the editor's
 * plugins don't react in between. `finish` gives the transaction, with the
 * last command's selection.
 */
export function compose(start: EditorState) {
  const tr = start.tr;
  let state = EditorState.create({ schema, doc: start.doc, selection: start.selection });
  return {
    tr,
    get state() {
      return state;
    },
    run: (command: Command) =>
      command(state, (t) => {
        t.steps.forEach((step) => tr.step(step));
        state = state.apply(t);
      }),
    /** Puts the cursor at `pos`, or as near it as a cursor can go. */
    select: (pos: number) => {
      state = state.apply(state.tr.setSelection(Selection.near(state.doc.resolve(pos))));
    },
    finish: () => tr.setSelection(Selection.fromJSON(tr.doc, state.selection.toJSON())),
  };
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

/**
 * Bold, italic, etc. A selection toggles the mark, or in revealed Markdown is
 * wrapped in `delimiter`. With just a cursor: in text with the mark, the mark
 * comes off the whole run; inside an empty `delimiter` pair, the pair goes;
 * elsewhere an empty pair goes in, as raw Markdown, with the cursor inside.
 */
export function formatSelection(view: EditorView, mark: string, delimiter: string): void {
  const { state } = view;
  if (!state.selection.empty) {
    if (inRawMarkdown(view)) wrapInRaw(view, delimiter, delimiter);
    else toggleMark(schema.marks[mark])(state, view.dispatch);
    return;
  }
  const { from, $from } = state.selection;
  const raw = schema.marks['md_raw'];
  const size = delimiter.length;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - size), $from.parentOffset);
  const after = $from.parent.textBetween($from.parentOffset, Math.min($from.parent.content.size, $from.parentOffset + size));
  if (before === delimiter && after === delimiter && state.doc.rangeHasMark(from - size, from + size, raw)) {
    view.dispatch(state.tr.delete(from - size, from + size));
    return;
  }
  const unformatted = removeMarkAtCursor(state, schema.marks[mark]);
  if (unformatted) return view.dispatch(unformatted);
  const tr = state.tr.insert(from, schema.text(delimiter + delimiter, [raw.create()]));
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + size)));
}

/** Stands in for the cursor while its textblock goes through Markdown. */
const CURSOR = '';

/**
 * Takes `type` off the run of it around the cursor, reading revealed Markdown
 * as what it parses to; null if the cursor isn't in such a run. The cursor
 * stays on the same character, and the run reveals afresh around it.
 */
function removeMarkAtCursor(state: EditorState, type: MarkType): Transaction | null {
  const { $from } = state.selection;
  const block = $from.parent;
  if (!block.isTextblock || block.type.spec.code) return null;
  const marks = $from.marks();
  const raw = schema.marks['md_raw'].isInSet(marks);
  if (!raw && !type.isInSet(marks)) return null;

  // Through Markdown and back, with a marker where the cursor is. A revealed
  // `## ` stays as it is: it isn't saved, and the block's type says the same.
  const lead = block.firstChild;
  const prefix = lead && schema.marks['md_prefix'].isInSet(lead.marks) ? lead.nodeSize : 0;
  const offset = $from.parentOffset - prefix;
  if (offset < 0) return null;
  const content = block.content.cut(prefix);
  const marked = content
    .cut(0, offset)
    .append(Fragment.from(schema.text(CURSOR, raw ? [raw] : marks)))
    .append(content.cut(offset));
  const parsed = parseMarkdown(serializeMarkdown(schema.node('doc', null, [block.copy(marked)]))).firstChild;
  if (!parsed?.isTextblock) return null;
  let cursor = -1;
  const children: { node: PMNode; from: number }[] = [];
  parsed.forEach((node, from) => {
    children.push({ node, from });
    if (node.isText && node.text!.includes(CURSOR)) cursor = children.length - 1;
  });
  const at = children[cursor];
  const mark = at && type.isInSet(at.node.marks);
  if (!mark) return null;
  let first = cursor;
  let last = cursor;
  while (first > 0 && mark.isInSet(children[first - 1].node.marks)) first--;
  while (last < children.length - 1 && mark.isInSet(children[last + 1].node.marks)) last++;

  const doc = new Transform(schema.node('doc', null, [parsed]));
  doc.removeMark(1 + children[first].from, 1 + children[last].from + children[last].node.nodeSize, mark);
  const cursorAt = at.from + at.node.text!.indexOf(CURSOR);
  doc.delete(1 + cursorAt, 2 + cursorAt);
  const start = $from.start() + prefix;
  const tr = state.tr.replaceWith(start, $from.end(), doc.doc.firstChild!.content);
  return tr.setSelection(TextSelection.create(tr.doc, start + cursorAt));
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
  void readText().then((text) => text && view.dispatch(view.state.tr.insertText(text)));
}
