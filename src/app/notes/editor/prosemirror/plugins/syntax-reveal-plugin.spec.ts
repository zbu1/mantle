import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { history, undo } from 'prosemirror-history';
import { Node as PMNode } from 'prosemirror-model';
import { parseMarkdown, serializeMarkdown } from '../markdown-converter';
import { schema } from '../schema';
import { EditorView } from 'prosemirror-view';
import { exitEmptyQuoteLine, revealImageSource, syntaxRevealPlugin } from './syntax-reveal-plugin';

function stateFor(markdown: string): EditorState {
  return EditorState.create({ doc: parseMarkdown(markdown), plugins: [history(), syntaxRevealPlugin()] });
}

/** Position of the first match of `needle` in a textblock (leaves count as one character). */
function find(doc: PMNode, needle: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (!node.isTextblock) return true;
    const i = node.textBetween(0, node.content.size, undefined, '￼').indexOf(needle);
    if (i >= 0) found = pos + 1 + i;
    return false;
  });
  if (found < 0) throw new Error(`"${needle}" not in ${doc.textContent}`);
  return found;
}

const cursor = (state: EditorState, pos: number) => state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
const cursorAt = (state: EditorState, needle: string, offset = 0) => cursor(state, find(state.doc, needle) + offset);
const type = (state: EditorState, text: string) => state.apply(state.tr.insertText(text));
const backspace = (state: EditorState, count = 1) => {
  for (let i = 0; i < count; i++) state = state.apply(state.tr.delete(state.selection.from - 1, state.selection.from));
  return state;
};
const text = (state: EditorState) => state.doc.textBetween(0, state.doc.content.size, '\n', '￼');

describe('revealing Markdown syntax', () => {
  it('shows a mark’s delimiters while the cursor is in it, without changing the Markdown', () => {
    const markdown = 'a **bold** and __strong__ b';
    let state = cursorAt(stateFor(markdown), 'old');
    expect(text(state)).toBe('a **bold** and strong b');
    expect(serializeMarkdown(state.doc)).toBe(markdown);

    state = cursorAt(state, 'tron');
    expect(text(state)).toBe('a bold and __strong__ b');
    expect(serializeMarkdown(state.doc)).toBe(markdown);
    expect(state.doc.firstChild!.child(1).marks[0].type.name).toBe('strong');
  });

  it('reveals nested marks together, from the innermost', () => {
    let state = cursorAt(stateFor('x **a _b_ c** y'), 'b');
    expect(text(state)).toBe('x **a _b_ c** y');
    state = cursorAt(state, 'y');
    expect(text(state)).toBe('x a b c y');
    expect(serializeMarkdown(state.doc)).toBe('x **a _b_ c** y');
  });

  it('keeps the cursor outside the opening delimiter when it arrives at the start', () => {
    const state = cursorAt(stateFor('a *it* b'), 'it');
    expect(state.selection.from).toBe(find(state.doc, '*it'));
  });

  it('parses edited syntax back, and leaves what no longer parses as text', () => {
    let state = cursorAt(stateFor('a *it* b'), 'it');
    state = cursorAt(state, '*it*', 1);
    state = type(state, '*'); // **it*
    state = cursorAt(state, 'a ', 0);
    expect(text(state)).toBe('a *it b');
    expect(serializeMarkdown(state.doc)).toBe('a **it* b');

    state = cursorAt(stateFor('a *it* b'), 'it');
    state = cursorAt(state, 'it*', 2);
    state = type(state, '*'); // *it**
    state = cursorAt(state, 'a ', 0);
    expect(serializeMarkdown(state.doc)).toBe('a *it** b');
  });

  it('reveals a link in full', () => {
    let state = cursorAt(stateFor('see [docs](https://x.dev "Title") now'), 'docs');
    expect(text(state)).toBe('see [docs](https://x.dev "Title") now');
    state = cursorAt(state, 'now');
    expect(state.doc.firstChild!.child(1).marks[0].attrs['href']).toBe('https://x.dev');
  });

  it('shows the backslash of an escaped character beside the cursor', () => {
    let state = cursorAt(stateFor('a \\*b\\* c'), '*');
    expect(text(state)).toBe('a \\*b* c');
    state = cursorAt(state, 'c');
    expect(text(state)).toBe('a *b* c');
    expect(serializeMarkdown(state.doc)).toBe('a \\*b\\* c');
  });

  it('shows nothing for a character that needs no escape', () => {
    const state = cursorAt(stateFor('a * b'), '*');
    expect(text(state)).toBe('a * b');
    expect(serializeMarkdown(state.doc)).toBe('a * b');
  });

  it('reveals a heading’s level as an editable prefix', () => {
    let state = cursorAt(stateFor('## Title'), 'Title');
    expect(text(state)).toBe('## Title');
    expect(serializeMarkdown(state.doc)).toBe('## Title');

    state = cursorAt(state, '## ');
    state = type(state, '#');
    expect(state.doc.firstChild!.attrs['level']).toBe(3);
    expect(serializeMarkdown(state.doc)).toBe('### Title');

    state = cursorAt(state, 'Title');
    state = backspace(state); // "###Title" is no heading
    expect(state.doc.firstChild!.type.name).toBe('paragraph');
    expect(text(state)).toBe('###Title');
  });

  it('turns a heading into a paragraph when its whole prefix is deleted', () => {
    let state = cursorAt(stateFor('# Title'), 'Title');
    state = state.apply(state.tr.delete(1, 3));
    expect(state.doc.firstChild!.type.name).toBe('paragraph');
    expect(text(state)).toBe('Title');
  });

  it('reveals a quote line’s `>` and leaves the quote when it’s deleted', () => {
    let state = cursorAt(stateFor('> quoted'), 'quoted');
    expect(text(state)).toBe('> quoted');
    expect(serializeMarkdown(state.doc)).toBe('> quoted');
    state = backspace(state, 2);
    expect(state.doc.firstChild!.type.name).toBe('paragraph');
    expect(serializeMarkdown(state.doc)).toBe('quoted');
  });

  it('leaves a quote on Enter at an empty quote line', () => {
    let state = cursorAt(stateFor('> a\n>\n> b'), 'b');
    state = cursorAt(state, 'a', 1);
    state = state.apply(state.tr.split(state.selection.from));
    expect(text(state)).toBe('a\n> \nb');
    exitEmptyQuoteLine(state, (tr) => (state = state.apply(tr)));
    expect(state.doc.content.content.map((node) => node.type.name)).toEqual(['blockquote', 'paragraph', 'blockquote']);
  });

  it('reveals a horizontal rule as its text, and keeps the style the file used', () => {
    let state = stateFor('a\n\n***\n\nb');
    state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, find(state.doc, 'a') + 2)));
    expect(text(state)).toBe('a\n***\nb');
    expect(serializeMarkdown(state.doc)).toBe('a\n\n***\n\nb');
    state = cursorAt(state, 'b');
    expect(state.doc.child(1).type.name).toBe('horizontal_rule');
    expect(serializeMarkdown(state.doc)).toBe('a\n\n***\n\nb');
  });

  it('shows a code block’s fences, and its opening fence sets the language', () => {
    const markdown = '```ts\nlet a;\n```\n\nafter';
    let state = cursorAt(stateFor(markdown), 'let');
    expect(state.doc.firstChild!.textContent).toBe('```ts\nlet a;\n```');
    expect(serializeMarkdown(state.doc)).toBe(markdown);

    state = cursorAt(state, 'ts', 2);
    state = backspace(state, 2);
    state = type(state, 'py');
    expect(state.doc.firstChild!.attrs['params']).toBe('py');

    state = cursorAt(state, 'after');
    expect(state.doc.firstChild!.textContent).toBe('let a;');
    expect(serializeMarkdown(state.doc)).toBe('```py\nlet a;\n```\n\nafter');
  });

  it('reveals a tilde fence as written, and shows no fences for indented code', () => {
    let state = cursorAt(stateFor('~~~\nlet a;\n~~~\n\nafter'), 'let');
    expect(state.doc.firstChild!.textContent).toBe('~~~\nlet a;\n~~~');
    state = cursorAt(state, 'after');
    expect(serializeMarkdown(state.doc)).toBe('~~~\nlet a;\n~~~\n\nafter');

    state = cursorAt(stateFor('    let a;\n\nafter'), 'let');
    expect(state.doc.firstChild!.textContent).toBe('let a;');
  });

  it('shows only a focus ring for a selected image', () => {
    let state = stateFor('x ![alt](a.png) y');
    state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, find(state.doc, '￼'))));
    expect(text(state)).toBe('x ￼ y');
  });

  it('shows an image’s source beside the cursor, and drops the source with the image', () => {
    const markdown = 'x ![alt](a.png) y';
    let state = cursorAt(stateFor(markdown), '￼');
    expect(text(state)).toBe('x ![alt](a.png)￼ y');
    expect(serializeMarkdown(state.doc)).toBe(markdown);

    const image = find(state.doc, '￼');
    state = state.apply(state.tr.delete(image, image + 1));
    expect(text(state)).toBe('x  y');
  });

  it('shows an image’s source once, when the cursor comes back to it', () => {
    let state = stateFor('x ![alt](a.png) y');
    const select = () => (state = cursorAt(state, '￼', 1));
    select();
    state = cursorAt(state, 'a.png');
    select();
    expect(text(state)).toBe('x ![alt](a.png)￼ y');
  });

  it('reveals and selects an image’s source on request', () => {
    const view = new EditorView(document.createElement('div'), { state: stateFor('**b** ![one](1.png) and ![two](2.png)') });
    revealImageSource(view, find(view.state.doc, 'and ') + 4);
    const { from, to } = view.state.selection;
    expect(view.state.doc.textBetween(from, to)).toBe('![two](2.png)');
    view.destroy();
  });

  it('takes an edited image source on leaving', () => {
    let state = cursorAt(stateFor('x ![alt](a.png) y'), '￼');
    state = cursorAt(state, 'a.png');
    state = state.apply(state.tr.insertText('b', state.selection.from, state.selection.from + 1));
    state = cursorAt(state, 'y');
    let src = '';
    state.doc.descendants((node) => void (node.type === schema.nodes['image'] && (src = node.attrs['src'])));
    expect(src).toBe('b.png');
    expect(serializeMarkdown(state.doc)).toBe('x ![alt](b.png) y');
  });

  it('keeps unfolding out of undo history, so undo still reverts typing inside syntax', () => {
    let state = cursorAt(stateFor('a **bold** b'), 'old');
    state = type(state, 'X');
    state = cursorAt(state, ' b', 2);
    expect(serializeMarkdown(state.doc)).toBe('a **bXold** b');
    undo(state, (tr) => (state = state.apply(tr)));
    state = cursorAt(state, ' b', 2);
    expect(serializeMarkdown(state.doc)).toBe('a **bold** b');
  });
});
