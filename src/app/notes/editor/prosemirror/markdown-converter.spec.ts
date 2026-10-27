import { parseMarkdown, serializeMarkdown } from './markdown-converter';
import { schema } from './schema';

describe('markdown images', () => {
  const roundTrip = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));

  it('round-trips Markdown images and Obsidian embeds in their own syntax', () => {
    expect(roundTrip('a ![cat](attachments/cat.png "Tom") b')).toBe('a ![cat](attachments/cat.png "Tom") b');
    expect(roundTrip('![[my cat.png|300]] and ![[dog.JPG]]')).toBe('![[my cat.png|300]] and ![[dog.JPG]]');
    expect(roundTrip('![[attachments/ab12.png.enc|300]]')).toBe('![[attachments/ab12.png.enc|300]]');
    expect(roundTrip('![[report.pdf|600]]')).toBe('![[report.pdf|600]]');
  });

  it('parses an embed into an image node with its size', () => {
    const image = parseMarkdown('![[cat.png|300x200]]').firstChild!.firstChild!;
    expect(image.type.name).toBe('image');
    expect(image.attrs).toMatchObject({ src: 'cat.png', embed: true, size: '300x200' });
  });

  it('embeds a PDF as an image node, so it shows inline', () => {
    expect(parseMarkdown('![[docs/report.pdf|600]]').firstChild!.firstChild!.attrs).toMatchObject({ src: 'docs/report.pdf', size: '600' });
  });

  it('shows embeds of notes as links to them', () => {
    const embed = parseMarkdown('![[Some note]]').firstChild!.firstChild!;
    expect(embed.marks[0].attrs).toMatchObject({ target: 'Some note', embed: true });
  });
});

describe('highlights and comments', () => {
  const roundTrip = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));

  it('parses ==highlights==, with Markdown inside, and %%comments%% as written', () => {
    const [a, b, , c] = parseMarkdown('==a **b**== x %% *c* %%').firstChild!.children;
    expect(a.marks.map((m) => m.type.name)).toEqual(['highlight']);
    expect(b.marks.map((m) => m.type.name).sort()).toEqual(['highlight', 'strong']);
    expect(c.text).toBe(' *c* ');
    expect(c.marks.map((m) => m.type.name)).toEqual(['comment']);
  });

  it('round-trips them, and leaves what isn’t one as text', () => {
    for (const markdown of ['==a **b**== x %% *c* %%', 'a == b == c', 'x = y', '100%', '`==a==`']) {
      expect(roundTrip(markdown)).toBe(markdown);
    }
    expect(parseMarkdown('a == b == c').firstChild!.firstChild!.marks).toEqual([]);
  });
});

describe('math', () => {
  const roundTrip = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));

  it('parses $inline$ and multi-line $$display$$ math as written', () => {
    const [, inline] = parseMarkdown('a $x_1 * y$ b').firstChild!.children;
    expect(inline.text).toBe('x_1 * y');
    expect(inline.marks[0].attrs).toEqual({ display: false });
    const block = parseMarkdown('$$\n\\frac{a}{b}\n$$').firstChild!.firstChild!;
    expect(block.text).toBe('\n\\frac{a}{b}\n');
    expect(block.marks[0].attrs).toEqual({ display: true });
  });

  it('round-trips it, and leaves dollars that aren’t math as text', () => {
    for (const markdown of ['a $x_1 * y$ b', '$$\n\\frac{a}{b}\n$$', '> $$a\n> b$$', 'costs $5 and $10', 'a \\$x\\$ b', '`$a$`']) {
      expect(roundTrip(markdown)).toBe(markdown);
    }
    expect(parseMarkdown('costs $5 and $10').firstChild!.firstChild!.marks).toEqual([]);
    expect(parseMarkdown('$1$2').firstChild!.firstChild!.marks).toEqual([]);
  });
});

describe('markdown line breaks', () => {
  it('keeps single newlines as line breaks', () => {
    const src = 'Oil\nPaprika\n\nSalt\nPepper';
    expect(serializeMarkdown(parseMarkdown(src))).toBe(src);
  });

  it('reads a backslash break as a newline', () => {
    expect(serializeMarkdown(parseMarkdown('a\\\nb'))).toBe('a\nb');
  });

  it('escapes what would start a block on the line after a break', () => {
    for (const line of ['- bar', '# h', '---', '===', '1. x', '1) x', '> q']) {
      const doc = schema.node('doc', null, [
        schema.nodes['paragraph'].create(null, [schema.text('foo'), schema.nodes['hard_break'].create(), schema.text(line)]),
      ]);
      expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true);
    }
  });
});

describe('markdown escaping', () => {
  const roundTrip = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));

  it('leaves syntax it does not read as written', () => {
    for (const src of ['> [!note] Title\n> body', 'a[^1]\n\n[^1]: note', '- [-] cancelled', '1. [ ] task', '2 * 3 * 4', 'x ~y~ z', '_a_b']) {
      expect(roundTrip(src)).toBe(src);
    }
  });

  it('still escapes text that would otherwise read as Markdown', () => {
    const doc = schema.node('doc', null, [schema.nodes['paragraph'].create(null, schema.text('*not em* and [[x]]'))]);
    expect(serializeMarkdown(doc)).toBe('\\*not em\\* and \\[\\[x\\]\\]');
  });
});

describe('markdown block styles', () => {
  const roundTrip = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));

  it('keeps setext headings and closing #s', () => {
    for (const src of ['Title\n=====', 'Sub\n---', '## Closed ##', '> Quoted\n> ===']) {
      expect(roundTrip(src)).toBe(src);
    }
  });

  it('keeps tilde fences and indented code', () => {
    for (const src of ['~~~\ncode\n~~~', '~~~~py\nx\n~~~~', '    indented\n    code', '```\n```']) {
      expect(roundTrip(src)).toBe(src);
    }
  });
});

describe('markdown lists', () => {
  const roundTrip = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));

  it('saves lists as written: marker, numbering and spacing', () => {
    for (const src of ['- a\n- b\n  - nested\n- c', '* a\n* b', '+ a', '1. a\n2. b', '0. a', '3) a\n4) b', '- a\n\n- loose']) {
      expect(roundTrip(src)).toBe(src);
    }
    expect(roundTrip(Array.from({ length: 10 }, (_, i) => `${i + 1}. x`).join('\n'))).toContain('\n9. x\n10. x');
  });

  it('keeps plain items plain in a list with checkboxes', () => {
    const src = '- [ ] task\n- plain\n- [x] done';
    expect(parseMarkdown(src).content.content.map((node) => node.type.name)).toEqual(['task_list', 'bullet_list', 'task_list']);
    expect(roundTrip(src)).toBe(src);
  });
});

describe('wikilinks', () => {
  const roundTrip = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));

  it('round-trips links to notes verbatim', () => {
    for (const src of ['[[Note]]', 'see [[Folder/Note#Part|the plan]] here', '![[Some note]]', '[[a_b*c]]']) {
      expect(roundTrip(src)).toBe(src);
    }
  });

  it('shows the alias, or else the target, as a link', () => {
    const [aliased, , plain] = parseMarkdown('[[Note#Part|see]] [[Other]]').firstChild!.content.content;
    expect(aliased.text).toBe('see');
    expect(aliased.marks[0].attrs).toMatchObject({ target: 'Note#Part', alias: true });
    expect(plain.text).toBe('Other');
  });

  it('leaves image embeds as images', () => {
    expect(parseMarkdown('![[cat.png]]').firstChild!.firstChild!.type.name).toBe('image');
  });
});
