import { EditorState, TextSelection } from 'prosemirror-state';
import { highlightCode, languageId, languageName } from '../code-languages';
import { parseMarkdown, serializeMarkdown } from '../markdown-converter';
import { filterSlashCommands } from '../../slash-menu/slash-menu.model';
import { codeBlockPlugin, codeBlockPluginKey, indentCodeLines } from './code-block-plugin';

function stateFor(markdown: string, from: number, to = from): EditorState {
  const doc = parseMarkdown(markdown);
  const plugins = [codeBlockPlugin({ pickLanguage: () => undefined, contextMenu: () => undefined })];
  return EditorState.create({ doc, plugins, selection: TextSelection.create(doc, from, to) });
}

describe('code blocks', () => {
  it('resolves fence languages through aliases, and leaves unknown ones unnamed', () => {
    expect(languageName('ts')).toBe('TypeScript');
    expect(languageId('py title="x"')).toBe('python');
    expect(languageName('klingon')).toBeNull();
    expect(languageName('')).toBeNull();
  });

  it('highlights only blocks with a known language, as offsets into the text', () => {
    const tokens = highlightCode('const x = "hi";', 'ts');
    expect(tokens).toContainEqual({ from: 0, to: 5, className: 'hljs-keyword' });
    expect(tokens).toContainEqual({ from: 10, to: 14, className: 'hljs-string' });
    expect(highlightCode('const x = 1;', '')).toEqual([]);
    expect(highlightCode('const x = 1;', 'klingon')).toEqual([]);
  });

  it('decorates code without touching the saved Markdown', () => {
    const markdown = '```js\nlet a = 1;\n```';
    const state = stateFor(markdown, 1);
    expect(codeBlockPluginKey.getState(state)!.decorations.find().length).toBeGreaterThan(0);
    expect(serializeMarkdown(state.doc)).toBe(markdown);
  });

  it('indents and outdents every line the selection touches', () => {
    // Positions inside the block start at 1: "a\nb\nc" → a=1, b=3, c=5.
    let state = stateFor('```\na\nb\nc\n```', 1, 4);
    indentCodeLines(false)(state, (tr) => (state = state.apply(tr)));
    expect(state.doc.firstChild!.textContent).toBe('  a\n  b\nc');

    indentCodeLines(true)(state, (tr) => (state = state.apply(tr)));
    expect(state.doc.firstChild!.textContent).toBe('a\nb\nc');
  });

  it('leaves Tab to lists outside a code block', () => {
    expect(indentCodeLines(false)(stateFor('text', 1))).toBe(false);
  });

  it('lists a code block per matching language for `/code <language>`', () => {
    expect(filterSlashCommands('code pyth').map((item) => item.label)).toContain('Code Block: Python');
    expect(filterSlashCommands('code').map((item) => item.label)).toEqual(['Code Block']);
  });
});
