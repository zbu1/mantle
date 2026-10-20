import { EditorState } from 'prosemirror-state';
import { LinkMenuState } from '../../link-menu/link-menu-state';
import { parseMarkdown } from '../markdown-converter';
import { wikilinkKey, wikilinkPlugin, wikilinkTargets } from './wikilink-plugin';

describe('wikilinkPlugin', () => {
  const doc = parseMarkdown('[[Here]] [[Gone#Part|alias]] `[[Code]]`');

  it('lists the targets of a note\'s links, outside code', () => {
    expect(wikilinkTargets(doc)).toEqual(['Here', 'Gone']);
  });

  it('marks the links that lead nowhere', () => {
    const plugin = wikilinkPlugin(
      { status: (target) => (target === 'Here' ? 'ok' : 'missing'), suggest: () => [] },
      new LinkMenuState(),
      () => null,
    );
    const state = EditorState.create({ doc, plugins: [plugin] });
    const broken = wikilinkKey.getState(state)!.find();
    expect(broken.map((d) => state.doc.textBetween(d.from, d.to))).toEqual(['alias']);
  });
});
