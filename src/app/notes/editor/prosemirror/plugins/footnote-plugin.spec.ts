import { parseMarkdown, serializeMarkdown } from '../markdown-converter';
import { findFootnotes } from './footnote-plugin';

describe('findFootnotes', () => {
  it('finds references and definitions, skipping code', () => {
    const doc = parseMarkdown('A claim[^1] and `[^2]`, again[^1].\n\n[^1]: The source.');
    const { refs, defs, definitions } = findFootnotes(doc);
    expect(refs.map((r) => [doc.textBetween(r.from, r.to), r.label])).toEqual([['[^1]', '1'], ['[^1]', '1']]);
    expect(defs.map((d) => doc.textBetween(d.from, d.to))).toEqual(['[^1]: ']);
    expect(definitions.get('1')).toBe('The source.');
  });
});

describe('task states', () => {
  const roundTrip = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));

  it('reads any one-character checkbox state and saves it as written', () => {
    const markdown = '- [ ] todo\n- [x] done\n- [X] Done\n- [-] cancelled\n- [/] half';
    expect(roundTrip(markdown)).toBe(markdown);
    const items: { checked: boolean; status: string | null }[] = [];
    parseMarkdown(markdown).descendants((node) => {
      if (node.type.name === 'task_item') items.push({ checked: node.attrs['checked'], status: node.attrs['status'] });
    });
    expect(items).toEqual([
      { checked: false, status: null },
      { checked: true, status: null },
      { checked: true, status: 'X' },
      { checked: true, status: '-' },
      { checked: true, status: '/' },
    ]);
  });

  it('does not read a wikilink as a checkbox', () => {
    expect(roundTrip('- [[note]] here')).toBe('- [[note]] here');
  });
});
