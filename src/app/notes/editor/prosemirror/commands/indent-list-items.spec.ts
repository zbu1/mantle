import { EditorState, TextSelection } from 'prosemirror-state';
import { parseMarkdown, serializeMarkdown } from '../markdown-converter';
import { indentListItems } from './indent-list-items';

/** Selects from the first to the last of `words` in `markdown`, presses (Shift-)Tab, and returns the Markdown and whether the key was taken. */
function press(markdown: string, outdent: boolean, ...words: string[]): { result: string; handled: boolean } {
  const doc = parseMarkdown(markdown);
  const at = (word: string) => {
    let pos = -1;
    doc.descendants((node, p) => {
      if (node.isText && pos < 0 && node.text!.includes(word)) pos = p + node.text!.indexOf(word) + 1;
    });
    return pos;
  };
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, at(words[0]), at(words.at(-1)!)) });
  const handled = indentListItems(outdent)(state, (tr) => (state = state.apply(tr)));
  return { result: serializeMarkdown(state.doc), handled };
}

describe('indentListItems', () => {
  it('indents an item under the one before it', () => {
    expect(press('- one\n- two', false, 'two').result).toBe('- one\n  - two');
  });

  it('leaves a first item alone but still takes the key', () => {
    expect(press('- one\n- two', false, 'one')).toEqual({ result: '- one\n- two', handled: true });
  });

  it('declines outside a list', () => {
    expect(press('plain', false, 'plain').handled).toBe(false);
  });

  it("indents only the item, leaving its children as its next siblings", () => {
    expect(press('- one\n- two\n  - three', false, 'two').result).toBe('- one\n  - two\n  - three');
  });

  it('outdents an item, bringing its children up and adopting the items after it', () => {
    expect(press('- one\n  - two\n    - three\n  - four', true, 'two').result).toBe('- one\n- two\n  - three\n  - four');
  });

  it('moves every selected item one level', () => {
    expect(press('- one\n- two\n- three', false, 'two', 'three').result).toBe('- one\n  - two\n  - three');
    expect(press('- one\n- two\n  - three', false, 'two', 'three').result).toBe('- one\n  - two\n    - three');
    expect(press('- one\n  - two\n    - three', true, 'two', 'three').result).toBe('- one\n- two\n  - three');
  });

  it('works for numbered and to-do lists', () => {
    expect(press('1. one\n2. two', false, 'two').result).toBe('1. one\n   1. two');
    expect(press('- [ ] one\n- [x] two', false, 'two').result).toBe('- [ ] one\n  - [x] two');
  });
});
