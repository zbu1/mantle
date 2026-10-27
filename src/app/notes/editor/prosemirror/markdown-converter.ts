import markdownIt from 'markdown-it';
import {
  MarkdownParser,
  MarkdownSerializer,
  MarkdownSerializerState,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown';
import { Node as PMNode, Mark as PMMark, Fragment } from 'prosemirror-model';
import { schema } from './schema';

const md = markdownIt('commonmark', { html: false });
md.enable('strikethrough');

/**
 * Obsidian `![[photo.png|300]]` image (and video) embeds, including the sealed
 * `….png.enc` an encrypted note's embed gets re-pointed at; embeds of anything
 * else (notes) stay text.
 */
const IMAGE_EMBED = /^!\[\[([^\]|\n]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp|mp4|m4v|webm|mov|ogv)(?:\.enc)?)(?:\|([^\]\n]*))?\]\]/i;
md.inline.ruler.before('image', 'image_embed', (state, silent) => {
  const match = IMAGE_EMBED.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    const token = state.push('image_embed', '', 0);
    token.attrs = [['src', match[1]]];
    token.meta = { size: match[2] || null };
  }
  state.pos += match[0].length;
  return true;
});

/**
 * `[[target#heading|alias]]` links to notes, and `![[…]]` embeds of them,
 * shown as links. Image embeds are left to `image_embed`.
 */
const WIKILINK = /^(!?)\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/;
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const rest = state.src.slice(state.pos);
  const match = WIKILINK.exec(rest);
  if (!match || (match[1] && IMAGE_EMBED.test(rest))) return false;
  if (!silent) {
    const open = state.push('wikilink_open', 'a', 1);
    open.attrs = [['target', match[2]]];
    open.meta = { alias: match[3] !== undefined, embed: !!match[1] };
    state.push('text', '', 0).content = match[3] ?? match[2];
    state.push('wikilink_close', 'a', -1);
  }
  state.pos += match[0].length;
  return true;
});

/**
 * `==highlight==`, whose inside is Markdown, and `%%comment%%`, whose inside is
 * kept as written.
 * ponytail: one line each, and the first closing delimiter wins even inside a code span; block comments stay text.
 */
const HIGHLIGHT = /^==(?=[^\s=])([^\n]*?[^\s=])==/;
const COMMENT = /^%%([^\n]+?)%%/;
md.inline.ruler.before('emphasis', 'highlight', (state, silent) => {
  const match = HIGHLIGHT.exec(state.src.slice(state.pos));
  if (!match) return false;
  const end = state.pos + match[0].length;
  if (!silent) {
    const max = state.posMax;
    state.push('highlight_open', 'mark', 1);
    state.pos += 2;
    state.posMax = end - 2;
    state.md.inline.tokenize(state);
    state.posMax = max;
    state.push('highlight_close', 'mark', -1);
  }
  state.pos = end;
  return true;
});
md.inline.ruler.before('emphasis', 'comment', (state, silent) => {
  const match = COMMENT.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    state.push('comment_open', 'span', 1);
    state.push('text', '', 0).content = match[1];
    state.push('comment_close', 'span', -1);
  }
  state.pos += match[0].length;
  return true;
});

/**
 * `$inline$` and `$$display$$` math, kept as written. `$$` may span lines of
 * one paragraph; `$` needs no space inside its delimiters and no digit after,
 * so `$5 and $10` stays text.
 * ponytail: the first closing delimiter wins, so `\$` can't appear inside; blank lines end a `$$` block.
 */
const MATH = /^\$\$([^$]+?)\$\$|^\$(?=[^\s$])([^\n$]*?[^\s$\\])\$(?!\d)/;
md.inline.ruler.before('emphasis', 'math', (state, silent) => {
  const match = MATH.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    // One text node, newlines and all: hidden, it needs no line breaks, and revealed it's raw text with its own.
    state.push('math_open', 'span', 1).meta = { display: match[1] !== undefined };
    state.push('text', '', 0).content = match[1] ?? match[2];
    state.push('math_close', 'span', -1);
  }
  state.pos += match[0].length;
  return true;
});

/** `[^1]: …` is a footnote, not a link reference definition, which would swallow it on save. */
type BlockRule = Parameters<typeof md.block.ruler.at>[1];
const reference = (md.block.ruler as unknown as { __rules__: { name: string; fn: BlockRule }[] }).__rules__.find(
  (rule) => rule.name === 'reference',
)!.fn;
md.block.ruler.at('reference', (state, start, end, silent) =>
  !state.src.startsWith('[^', state.bMarks[start] + state.tShift[start]) && reference(state, start, end, silent),
);

/** How each heading is written, which markdown-it doesn't record: a setext underline, or an ATX heading's closing `#`s. */
md.core.ruler.push('heading_style', (state) => {
  const lines = state.src.split('\n');
  for (const token of state.tokens) {
    if (token.type !== 'heading_open' || !token.map) continue;
    token.meta = /^[=-]/.test(token.markup)
      ? { underline: /[=-]+(?=[ \t]*$)/.exec(lines[token.map[1] - 1])?.[0] ?? null }
      : { closing: /[ \t]+#+(?=[ \t]*$)/.exec(lines[token.map[0]])?.[0] ?? '' };
  }
  return true;
});

/** markdown-it hides the paragraphs of a tight list (prosemirror-markdown's own check, which it doesn't export). */
function listIsTight(tokens: { type: string; hidden: boolean }[], i: number): boolean {
  while (++i < tokens.length) if (tokens[i].type !== 'list_item_open') return tokens[i].hidden;
  return false;
}

export const markdownParser = new MarkdownParser(schema, md, {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'list_item' },
  bullet_list: {
    block: 'bullet_list',
    getAttrs: (tok, tokens, i) => ({ tight: listIsTight(tokens, i), bullet: tok.markup }),
  },
  ordered_list: {
    block: 'ordered_list',
    getAttrs: (tok, tokens, i) => ({
      order: +(tok.attrGet('start') ?? 1),
      tight: listIsTight(tokens, i),
      delimiter: tok.markup,
    }),
  },
  heading: {
    block: 'heading',
    getAttrs: (tok) => ({ level: +tok.tag.slice(1), ...tok.meta }),
  },
  // Indented code.
  code_block: { block: 'code_block', getAttrs: () => ({ fence: '' }), noCloseToken: true },
  fence: {
    block: 'code_block',
    getAttrs: (tok) => ({ params: tok.info, fence: tok.markup }),
    noCloseToken: true,
  },
  hr: { node: 'horizontal_rule', getAttrs: (tok) => ({ markup: tok.markup }) },
  hardbreak: { node: 'hard_break' },
  // Obsidian shows a single newline as a line break; CommonMark would join the lines.
  softbreak: { node: 'hard_break' },
  image: {
    node: 'image',
    getAttrs: (tok) => ({
      src: tok.attrGet('src'),
      title: tok.attrGet('title') || null,
      alt: tok.children?.[0]?.content || null,
    }),
  },
  image_embed: {
    node: 'image',
    getAttrs: (tok) => ({ src: tok.attrGet('src'), embed: true, size: tok.meta.size }),
  },

  em: { mark: 'em', getAttrs: (tok) => ({ markup: tok.markup }) },
  strong: { mark: 'strong', getAttrs: (tok) => ({ markup: tok.markup }) },
  s: { mark: 'strike' },
  highlight: { mark: 'highlight' },
  comment: { mark: 'comment' },
  math: { mark: 'math', getAttrs: (tok) => ({ display: tok.meta.display }) },
  link: {
    mark: 'link',
    getAttrs: (tok) => ({
      href: tok.attrGet('href'),
      title: tok.attrGet('title') || null,
    }),
  },
  code_inline: { mark: 'code', noCloseToken: true },
  wikilink: {
    mark: 'wikilink',
    getAttrs: (tok) => ({ target: tok.attrGet('target'), alias: tok.meta.alias, embed: tok.meta.embed }),
  },
});

/** The textblock without its revealed `## ` / `> ` prefix, which is never saved. */
function withoutPrefix(node: PMNode): PMNode {
  const first = node.firstChild;
  return first && schema.marks['md_prefix'].isInSet(first.marks) ? node.cut(first.nodeSize) : node;
}

/**
 * A code block's code, fence and fence language. While its fences are revealed
 * they're part of its text, `offset` past the opening one; fences that no longer
 * read as fences are just code.
 */
export function codeBody(node: PMNode): { text: string; params: string; fence: string; offset: number } {
  const text = node.textContent;
  const { params, fence } = node.attrs;
  if (!node.attrs['revealed']) return { text, params, fence, offset: 0 };
  const lines = text.split('\n');
  // A backtick fence's language can't hold a backtick.
  const open = /^(`{3,}(?=[^`]*$)|~{3,})(.*)$/.exec(lines[0]);
  const close = lines.at(-1)!.trimEnd();
  if (lines.length < 2 || !open || close.length < open[1].length || close !== open[1][0].repeat(close.length)) {
    return { text, params: '', fence, offset: 0 };
  }
  return { text: lines.slice(1, -1).join('\n'), params: open[2].trim(), fence: open[1], offset: lines[0].length + 1 };
}

/** A code block's code, without fences, as a paragraph of its lines. */
export function codeAsParagraph(node: PMNode): PMNode {
  const content = codeBody(node)
    .text.split('\n')
    .flatMap((line, i) => [...(i > 0 ? [schema.nodes['hard_break'].create()] : []), ...(line ? [schema.text(line)] : [])]);
  return schema.nodes['paragraph'].create(null, content);
}

/** The fence a code block is written with: its own, lengthened past any run of the same character inside. */
export function codeFence(fence: string, text: string): string {
  const char = fence.startsWith('~') ? '~' : '`';
  const runs = text.match(char === '~' ? /~{3,}/g : /`{3,}/g) ?? [];
  return char.repeat(Math.max(3, fence.length, ...runs.map((run) => run.length + 1)));
}

/**
 * How text is escaped: `minimal` writes each textblock with no escapes when
 * that reads back the same, so syntax this editor doesn't know (`[!note]`,
 * `[^1]`, `2 * 3`) is saved as written; `all` escapes every special character.
 */
let escaping: 'minimal' | 'all' | 'none' = 'minimal';

type BlockSerializer = (state: MarkdownSerializerState, node: PMNode, parent: PMNode, index: number) => void;

function minimallyEscaped(render: BlockSerializer): BlockSerializer {
  return (state, node, parent, index) => {
    const bare = escaping === 'minimal' ? bareMarkdown(node) : null;
    if (bare === null) return render(state, node, parent, index);
    state.text(bare, false);
    state.closeBlock(node);
  };
}

/**
 * `block` as Markdown without escapes, if that reads back as the escaped version does.
 * ponytail: all or nothing per block, so one needed escape keeps every other; go per character if that bites.
 */
function bareMarkdown(block: PMNode): string | null {
  const doc = schema.node('doc', null, [block]);
  let escaped: string;
  let bare: string;
  try {
    escaping = 'all';
    escaped = markdownSerializer.serialize(doc);
    escaping = 'none';
    bare = markdownSerializer.serialize(doc);
  } finally {
    escaping = 'minimal';
  }
  if (bare === escaped) return null;
  return parseMarkdown(bare).eq(parseMarkdown(escaped)) ? bare : null;
}

const isImageSource = (node: PMNode | null | undefined): boolean =>
  !!node && !!schema.marks['md_raw'].isInSet(node.marks) && node.marks.some((mark) => mark.attrs['image']);

const delimiter = {
  open: (_state: unknown, mark: PMMark) => mark.attrs['markup'] as string,
  close: (_state: unknown, mark: PMMark) => mark.attrs['markup'] as string,
  mixable: true,
  expelEnclosingWhitespace: true,
};

export const markdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    paragraph: minimallyEscaped((state, node) => {
      let inline = withoutPrefix(node);
      const first = inline.firstChild;
      // A fence typed into a paragraph is text until the editor makes it a code block;
      // saved bare, it would swallow the rest of the note.
      if (first?.isText && schema.marks['md_raw'].isInSet(first.marks) && /^(```|~~~)/.test(first.text!)) {
        inline = inline.copy(Fragment.from(schema.text('\\' + first.text, first.marks)).append(inline.content.cut(first.nodeSize)));
      }
      state.renderInline(inline);
      state.closeBlock(node);
    }),
    heading: minimallyEscaped((state, node) => {
      const { level, underline, closing } = node.attrs;
      const inline = withoutPrefix(node);
      // Setext (`Title` over `===`) as long as the underline still matches the level.
      if (underline?.[0] === (level === 1 ? '=' : level === 2 ? '-' : null) && inline.content.size) {
        state.renderInline(inline);
        state.ensureNewLine();
        state.write(underline);
      } else {
        state.write(state.repeat('#', level) + ' ');
        state.renderInline(inline, false);
        state.write(closing);
      }
      state.closeBlock(node);
    }),
    code_block(state, node) {
      const { text, params, fence: written } = codeBody(node);
      // Blank lines at either end wouldn't survive in indented code.
      if (!written && !params && text.trim() && !/^[ \t]*\n|\n[ \t]*$/.test(text)) {
        // Indented code.
        state.text(text.replace(/^(?=.)/gm, '    '), false);
      } else {
        const fence = codeFence(written, text);
        state.write(fence + params + '\n');
        if (text) {
          state.text(text, false);
          state.ensureNewLine();
        }
        state.write(fence);
      }
      state.closeBlock(node);
    },
    bullet_list: renderBulletList,
    task_list: renderBulletList,
    // Numbers aren't padded to one width, so a tenth item doesn't indent the other nine.
    ordered_list(state, node) {
      const start: number = node.attrs['order'];
      const space = state.repeat(' ', String(start + node.childCount - 1).length + 2);
      state.renderList(node, space, (i) => `${start + i}${node.attrs['delimiter']} `);
    },
    text(state, node, parent, index) {
      if (escaping === 'none' || schema.marks['math'].isInSet(node.marks)) return state.text(node.text!, false);
      // A line after a hard break starts a line of the file, where `- `, `# `, … would start a block.
      if (index === 0 || parent.child(index - 1).type !== schema.nodes['hard_break']) {
        return defaultMarkdownSerializer.nodes['text'](state, node, parent, index);
      }
      const [, lead, rest] = /^(\s*)(.*)$/s.exec(node.text!)!;
      // `esc` misses `1)` lists and setext underlines.
      const escaped = state.esc(rest, true).replace(/^(\d+)\)/, '$1\\)').replace(/^=+\s*$/, '\\$&');
      state.text(lead + escaped, false);
    },
    task_item(state, node) {
      state.write(node.attrs['checked'] ? '[x] ' : '[ ] ');
      state.renderContent(node);
    },
    image(state, node, parent, index) {
      // Its revealed source, just before it, is saved instead.
      if (index > 0 && isImageSource(parent.child(index - 1))) return;
      const { src, size } = node.attrs;
      if (node.attrs['embed']) state.write(`![[${src}${size ? `|${size}` : ''}]]`);
      else defaultMarkdownSerializer.nodes['image'](state, node, parent, index);
    },
    // A plain newline, not CommonMark's `\`, so Obsidian-style notes keep their source.
    hard_break(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) return state.write('\n');
      }
    },
    horizontal_rule(state, node) {
      state.write(node.attrs['markup'] || '---');
      state.closeBlock(node);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    em: delimiter,
    strong: delimiter,
    wikilink: {
      open: (_state: unknown, mark: PMMark) =>
        `${mark.attrs['embed'] ? '!' : ''}[[${mark.attrs['alias'] ? `${mark.attrs['target']}|` : ''}`,
      close: ']]',
      escape: false,
    },
    md_raw: { open: '', close: '', escape: false },
    md_prefix: { open: '', close: '', escape: false },
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    highlight: { open: '==', close: '==', mixable: true, expelEnclosingWhitespace: true },
    comment: { open: '%%', close: '%%', escape: false },
    // Left unescaped by the `text` serializer, which also keeps a quote's or list's `> ` / indent on each line.
    math: {
      open: (_state: unknown, mark: PMMark) => (mark.attrs['display'] ? '$$' : '$'),
      close: (_state: unknown, mark: PMMark) => (mark.attrs['display'] ? '$$' : '$'),
    },
  },
  // A `$` that would start math reads as text again.
  { escapeExtraCharacters: /\$/g },
);

/** Whether the list at `index` continues the one before it: a checkbox run after a plain one, or the reverse. */
function continuesList(parent: PMNode, index: number): boolean {
  const lists = [schema.nodes['bullet_list'], schema.nodes['task_list']];
  const [prev, node] = [parent.maybeChild(index - 1), parent.child(index)];
  return !!prev && prev.type !== node.type && lists.includes(prev.type) && lists.includes(node.type) && prev.attrs['bullet'] === node.attrs['bullet'];
}

/**
 * A Markdown list with both checkbox and plain items is, here, a run of
 * `task_list`s and `bullet_list`s (see `transformTaskLists`); it saves as one list.
 */
function renderBulletList(state: MarkdownSerializerState, node: PMNode, parent: PMNode, index: number): void {
  if (continuesList(parent, index)) return;
  let last = index;
  while (last + 1 < parent.childCount && continuesList(parent, last + 1)) last++;
  const items: PMNode[] = [];
  let tight = true;
  for (let i = index; i <= last; i++) {
    parent.child(i).forEach((item) => items.push(item));
    tight &&= parent.child(i).attrs['tight'];
  }
  // Unchecked: a list of both kinds of item exists only here.
  const list = node.type.create({ ...node.attrs, tight }, items);
  state.renderList(list, '  ', () => node.attrs['bullet'] + ' ');
}

const CHECKBOX = /^\[([ xX])\](?:\s+|$)/;

/** The checkbox a list item starts with: whether it's checked, and the item without it. */
function taskItem(item: PMNode): PMNode | null {
  const paragraph = item.firstChild;
  const text = paragraph?.type === schema.nodes['paragraph'] ? paragraph.firstChild : null;
  const match = text?.isText ? CHECKBOX.exec(text.text!) : null;
  if (!paragraph || !text || !match) return null;
  const rest = text.text!.slice(match[0].length);
  const inline = rest ? paragraph.content.replaceChild(0, schema.text(rest, text.marks)) : paragraph.content.cut(text.nodeSize);
  return schema.nodes['task_item'].create({ checked: match[1] !== ' ' }, item.content.replaceChild(0, paragraph.copy(inline)));
}

function transformTaskLists(node: PMNode): PMNode {
  if (node.isLeaf) return node;
  const children: PMNode[] = [];
  node.forEach((child) => {
    child = transformTaskLists(child);
    if (child.type !== schema.nodes['bullet_list']) {
      children.push(child);
      return;
    }
    // Split into runs of checkbox and plain items.
    let run: PMNode[] = [];
    let tasks = false;
    const flush = () => {
      if (run.length) children.push((tasks ? schema.nodes['task_list'] : child.type).create(child.attrs, run));
      run = [];
    };
    child.forEach((item) => {
      const task = taskItem(item);
      if (!!task !== tasks) flush();
      tasks = !!task;
      run.push(task ?? item);
    });
    flush();
  });
  return node.copy(Fragment.from(children));
}

export function parseMarkdown(content: string): PMNode {
  const doc = markdownParser.parse(content || '') || schema.nodes['doc'].createAndFill()!;
  return transformTaskLists(doc);
}

export function serializeMarkdown(doc: PMNode): string {
  return markdownSerializer.serialize(doc);
}
