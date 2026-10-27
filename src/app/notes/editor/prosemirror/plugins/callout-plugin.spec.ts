import { EditorState, TextSelection } from 'prosemirror-state';
import { DecorationSet } from 'prosemirror-view';
import { parseMarkdown } from '../markdown-converter';
import { calloutFoldKey, calloutPlugin, findCallouts } from './callout-plugin';

function setup(markdown: string): EditorState {
  const doc = parseMarkdown(`Intro\n\n${markdown}`);
  return EditorState.create({ doc, selection: TextSelection.atStart(doc), plugins: [calloutPlugin()] });
}

function decorations(state: EditorState) {
  const set = calloutFoldKey.get(state)!.props.decorations!.call(null as never, state) as DecorationSet;
  return set.find().map((d) => ({ d, attrs: (d as unknown as { type: { attrs?: Record<string, string> } }).type.attrs ?? {} }));
}

/** Text the decorations hide, other than the marker. */
function hidden(state: EditorState): string[] {
  const [callout] = findCallouts(state.doc);
  return decorations(state)
    .filter(({ d, attrs }) => attrs['style'] === 'display: none' && d.from !== callout.markerFrom)
    .map(({ d }) => state.doc.textBetween(d.from, d.to))
    .sort();
}

describe('calloutPlugin', () => {
  it('finds a callout with its type, fold and title line', () => {
    const state = setup('> [!Warning]- Careful\n> body');
    const [callout] = findCallouts(state.doc);
    expect(callout).toMatchObject({ type: 'warning', fold: '-' });
    expect(state.doc.textBetween(callout.markerFrom, callout.markerTo)).toBe('[!Warning]- ');
    expect(state.doc.textBetween(callout.markerTo, callout.titleTo)).toBe('Careful');
    expect(decorations(state).some(({ attrs }) => attrs['class'] === 'callout callout-warning')).toBe(true);
  });

  it('leaves plain quotes alone', () => {
    expect(findCallouts(setup('> just a [!quote]').doc)).toEqual([]);
  });

  it('starts a `-` callout folded and a `+` one open, and toggles without changing the doc', () => {
    let state = setup('> [!note]- Title\n> line two\n>\n> second');
    expect(hidden(state)).toEqual(['line two', 'second']);
    const before = state.doc;
    state = state.apply(state.tr.setMeta(calloutFoldKey, findCallouts(state.doc)[0].pos));
    expect(hidden(state)).toEqual([]);
    expect(state.doc).toBe(before);

    expect(hidden(setup('> [!note]+ Title\n> body'))).toEqual([]);
  });

  it('unfolds when the cursor moves into the hidden body', () => {
    let state = setup('> [!tip]- Title\n> body');
    const end = state.doc.content.size - 2;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, end)));
    expect(hidden(state)).toEqual([]);
  });

  it('shows the marker as written while the cursor is on the title line', () => {
    let state = setup('> [!info] Title');
    const [callout] = findCallouts(state.doc);
    const markerHidden = () =>
      decorations(state).some(({ d, attrs }) => d.from === callout.markerFrom && attrs['style'] === 'display: none');
    expect(markerHidden()).toBe(true);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, callout.titleTo)));
    expect(markerHidden()).toBe(false);
  });
});
