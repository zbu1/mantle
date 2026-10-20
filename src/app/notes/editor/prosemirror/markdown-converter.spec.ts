import { parseMarkdown, serializeMarkdown } from './markdown-converter';

describe('markdown images', () => {
  const roundTrip = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));

  it('round-trips Markdown images and Obsidian embeds in their own syntax', () => {
    expect(roundTrip('a ![cat](attachments/cat.png "Tom") b')).toBe('a ![cat](attachments/cat.png "Tom") b');
    expect(roundTrip('![[my cat.png|300]] and ![[dog.JPG]]')).toBe('![[my cat.png|300]] and ![[dog.JPG]]');
    expect(roundTrip('![[attachments/ab12.png.enc|300]]')).toBe('![[attachments/ab12.png.enc|300]]');
  });

  it('parses an embed into an image node with its size', () => {
    const image = parseMarkdown('![[cat.png|300x200]]').firstChild!.firstChild!;
    expect(image.type.name).toBe('image');
    expect(image.attrs).toMatchObject({ src: 'cat.png', embed: true, size: '300x200' });
  });

  it('shows embeds of notes as links to them', () => {
    const embed = parseMarkdown('![[Some note]]').firstChild!.firstChild!;
    expect(embed.marks[0].attrs).toMatchObject({ target: 'Some note', embed: true });
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
