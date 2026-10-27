import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo } from 'prosemirror-history';
import { parseMarkdown, serializeMarkdown } from './markdown-converter';
import { syntaxRevealPlugin, taskMarkerPlugin } from './plugins/syntax-reveal-plugin';
import { BlockKind, formatSelection, turnInto } from './editor-commands';

/** Puts the cursor inside "hello" in `markdown`, turns that block into `kind`, and returns the Markdown. */
function turn(markdown: string, kind: BlockKind): { result: string; view: EditorView } {
  const doc = parseMarkdown(markdown);
  let pos = 0;
  doc.descendants((node, at) => {
    if (node.isText && node.text!.includes('hello')) pos = at + node.text!.indexOf('hello') + 2;
  });
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, pos),
    plugins: [history(), taskMarkerPlugin(), syntaxRevealPlugin()],
  });
  const view = new EditorView(document.createElement('div'), { state });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  turnInto(view, kind);
  return { result: serializeMarkdown(view.state.doc), view };
}

describe('turnInto', () => {
  it.each<[string, BlockKind, string]>([
    ['hello', 'h2', '## hello'],
    ['## hello', 'paragraph', 'hello'],
    ['## hello', 'bullet_list', '- hello'],
    ['- hello', 'ordered_list', '1. hello'],
    ['- a\n- hello', 'task_list', '- [ ] a\n- [ ] hello'],
    ['- [x] hello', 'bullet_list', '- hello'],
    ['> hello', 'paragraph', 'hello'],
    ['- hello', 'paragraph', 'hello'],
    ['- hello', 'h1', '# hello'],
    ['hello', 'blockquote', '> hello'],
    ['## hello', 'code_block', '```\nhello\n```'],
    ['> hello', 'code_block', '> ```\n> hello\n> ```'],
    ['- a\n  - hello', 'ordered_list', '- a\n  1. hello'],
    ['```\nhello\n```', 'bullet_list', '- hello'],
  ])('%j into %s', (markdown, kind, expected) => {
    expect(turn(markdown, kind).result).toBe(expected);
  });

  it.each<[string, BlockKind]>([
    ['## hello', 'h2'],
    ['> hello', 'blockquote'],
    ['- hello', 'bullet_list'],
    ['```\nhello\n```', 'code_block'],
  ])('leaves %j alone when it already is %s', (markdown, kind) => {
    expect(turn(markdown, kind).result).toBe(markdown);
  });

  it('is one undo step', () => {
    const { view } = turn('## hello', 'bullet_list');
    undo(view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc)).toBe('## hello');
  });
});

describe('formatSelection with just a cursor', () => {
  /** An editor on `markdown` with the cursor `offset` characters into the first text containing `word`. */
  function editor(markdown: string, word: string, offset: number, reveal = true): EditorView {
    const doc = parseMarkdown(markdown);
    let pos = -1;
    doc.descendants((node, p) => {
      if (pos < 0 && node.isText && node.text!.includes(word)) pos = p + node.text!.indexOf(word) + offset;
    });
    const plugins = [history(), ...(reveal ? [syntaxRevealPlugin()] : [])];
    const view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc, plugins }) });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    return view;
  }
  const markdown = (view: EditorView) => serializeMarkdown(view.state.doc);

  it('puts in an empty pair around the cursor, and takes it out again', () => {
    const view = editor('hello world', 'world', 0);
    formatSelection(view, 'strong', '**');
    expect(markdown(view)).toBe('hello ****world');
    expect(view.state.doc.textBetween(view.state.selection.from - 2, view.state.selection.from)).toBe('**');
    formatSelection(view, 'strong', '**');
    expect(markdown(view)).toBe('hello world');
  });

  it('takes the mark off the whole run the cursor is in', () => {
    const view = editor('a **bold** b', 'bold', 2);
    formatSelection(view, 'strong', '**');
    expect(markdown(view)).toBe('a bold b');
  });

  it('does the same when the Markdown is not revealed', () => {
    const view = editor('a ==lit== b', 'lit', 1, false);
    formatSelection(view, 'highlight', '==');
    expect(markdown(view)).toBe('a lit b');
  });

  it('keeps a heading a heading', () => {
    const view = editor('## a ~~gone~~', 'gone', 2);
    formatSelection(view, 'strike', '~~');
    expect(markdown(view)).toBe('## a gone');
  });
});
