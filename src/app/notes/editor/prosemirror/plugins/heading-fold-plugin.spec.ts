import { EditorState, TextSelection } from 'prosemirror-state';
import { history, undoDepth } from 'prosemirror-history';
import { DecorationSet } from 'prosemirror-view';
import { parseMarkdown } from '../markdown-converter';
import { enterAfterFold, foldedHeadings, headingFoldKey, headingFoldPlugin, setFoldedHeadings } from './heading-fold-plugin';

const MARKDOWN = '# One\n\na\n\n## Two\n\nb\n\n# Three\n\nc';

function setup(): EditorState {
  const doc = parseMarkdown(MARKDOWN);
  return EditorState.create({ doc, selection: TextSelection.atStart(doc), plugins: [history(), headingFoldPlugin()] });
}

/** Start of the text `text`. */
function find(state: EditorState, text: string): number {
  let pos = 0;
  state.doc.descendants((node, p) => {
    if (node.isText && node.text === text) pos = p;
  });
  return pos;
}

/** Text of the blocks the fold decorations hide. */
function hidden(state: EditorState): string[] {
  const set = headingFoldKey.get(state)!.props.decorations!.call(null as never, state) as DecorationSet;
  return set
    .find()
    .filter((d) => (d as unknown as { type: { attrs?: { style?: string } } }).type.attrs?.style === 'display: none')
    .map((d) => state.doc.nodeAt(d.from)!.textContent);
}

describe('headingFoldPlugin', () => {
  it('hides a section up to the next heading of the same or a higher level, without an undo step', () => {
    let state = setup();
    state = state.apply(setFoldedHeadings(state.tr, [0]));
    expect(hidden(state)).toEqual(['a', 'Two', 'b']);
    expect(foldedHeadings(state)).toEqual([0]);
    expect(undoDepth(state)).toBe(0);
    expect(state.doc.textContent).toBe('OneaTwobThreec');
  });

  it('stops a lower heading at the next one of its level or higher', () => {
    let state = setup();
    state = state.apply(setFoldedHeadings(state.tr, [1]));
    expect(hidden(state)).toEqual(['b']);
  });

  it('unfolds when the cursor moves into the section', () => {
    let state = setup();
    state = state.apply(setFoldedHeadings(state.tr, [0]));
    let pos = 0;
    state.doc.descendants((node, p) => {
      if (node.isText && node.text === 'b') pos = p;
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    expect(foldedHeadings(state)).toEqual([]);
  });

  it('takes the cursor out of a section it folds', () => {
    let state = setup();
    let pos = 0;
    state.doc.descendants((node, p) => {
      if (node.isText && node.text === 'a') pos = p;
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    state = state.apply(setFoldedHeadings(state.tr, [0]));
    expect(foldedHeadings(state)).toEqual([0]);
    expect(state.selection.$head.parent.textContent).toBe('One');
  });

  it('puts Enter at the end of a folded heading on a new line after its section, still folded', () => {
    for (const [index, heading, after] of [
      [1, 'Two', 'Three'],
      [2, 'Three', null],
    ] as const) {
      let state = setup();
      state = state.apply(setFoldedHeadings(state.tr, [index]));
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, find(state, heading) + heading.length)));
      enterAfterFold(state, (tr) => (state = state.apply(tr)));
      state = state.apply(state.tr.insertText('new'));
      expect(foldedHeadings(state)).toEqual([index]);
      expect(state.selection.$head.parent.textContent).toBe('new');
      expect(hidden(state)).not.toContain('new');
      expect(state.doc.childAfter(state.selection.$head.after()).node?.textContent ?? null).toBe(after);
    }
  });

  it('keeps following its heading through edits above it', () => {
    let state = setup();
    state = state.apply(setFoldedHeadings(state.tr, [2]));
    state = state.apply(state.tr.insertText('x', 1));
    expect(foldedHeadings(state)).toEqual([2]);
    expect(hidden(state)).toEqual(['c']);
  });
});
