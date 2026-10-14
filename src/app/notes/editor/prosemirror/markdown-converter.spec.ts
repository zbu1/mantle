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

  it('leaves embeds of notes as text', () => {
    expect(parseMarkdown('![[Some note]]').firstChild!.textContent).toBe('![[Some note]]');
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
