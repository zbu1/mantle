import markdownIt from 'markdown-it';
import {
  MarkdownParser,
  MarkdownSerializer,
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

export const markdownParser = new MarkdownParser(schema, md, {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'list_item' },
  bullet_list: { block: 'bullet_list' },
  ordered_list: {
    block: 'ordered_list',
    getAttrs: (tok) => ({ order: +(tok.attrGet('start') || 1) }),
  },
  heading: {
    block: 'heading',
    getAttrs: (tok) => ({ level: +tok.tag.slice(1) }),
  },
  code_block: { block: 'code_block', noCloseToken: true },
  fence: {
    block: 'code_block',
    getAttrs: (tok) => ({ params: tok.info }),
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
 * A code block's code and fence language. While its fences are revealed they're
 * part of its text, `offset` past the opening one; fences that no longer read
 * as fences are just code.
 */
export function codeBody(node: PMNode): { text: string; params: string; offset: number } {
  const text = node.textContent;
  if (!node.attrs['revealed']) return { text, params: node.attrs['params'], offset: 0 };
  const lines = text.split('\n');
  const open = /^(`{3,})([^`]*)$/.exec(lines[0]);
  const close = lines.at(-1)!.trimEnd();
  if (lines.length < 2 || !open || !/^`+$/.test(close) || close.length < open[1].length) {
    return { text, params: '', offset: 0 };
  }
  return { text: lines.slice(1, -1).join('\n'), params: open[2].trim(), offset: lines[0].length + 1 };
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
    paragraph(state, node) {
      let inline = withoutPrefix(node);
      const first = inline.firstChild;
      // A fence typed into a paragraph is text until the editor makes it a code block;
      // saved bare, it would swallow the rest of the note.
      if (first?.isText && schema.marks['md_raw'].isInSet(first.marks) && /^(```|~~~)/.test(first.text!)) {
        inline = inline.copy(Fragment.from(schema.text('\\' + first.text, first.marks)).append(inline.content.cut(first.nodeSize)));
      }
      state.renderInline(inline);
      state.closeBlock(node);
    },
    heading(state, node) {
      state.write(state.repeat('#', node.attrs['level']) + ' ');
      state.renderInline(withoutPrefix(node), false);
      state.closeBlock(node);
    },
    code_block(state, node, parent, index) {
      const { text, params } = codeBody(node);
      const folded = node.type.create({ params }, text ? schema.text(text) : null);
      defaultMarkdownSerializer.nodes['code_block'](state, folded, parent, index);
    },
    task_list(state, node) {
      state.renderList(node, '  ', () => '- ');
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
  }
);

function transformTaskLists(node: PMNode): PMNode {
  if (node.type === schema.nodes['bullet_list']) {
    let isTaskList = false;
    node.forEach((child) => {
      if (child.type === schema.nodes['list_item']) {
        const firstParagraph = child.firstChild;
        if (firstParagraph && firstParagraph.type === schema.nodes['paragraph']) {
          const firstText = firstParagraph.firstChild;
          if (firstText && firstText.isText && /^\[([ xX])\]\s*/.test(firstText.text || '')) {
            isTaskList = true;
          }
        }
      }
    });

    if (isTaskList) {
      const taskItems: PMNode[] = [];
      node.forEach((child) => {
        if (child.type === schema.nodes['list_item']) {
          let checked = false;
          const newChildren: PMNode[] = [];

          child.forEach((block, _offset, index) => {
            if (index === 0 && block.type === schema.nodes['paragraph']) {
              const textChild = block.firstChild;
              if (textChild && textChild.isText) {
                const match = textChild.text?.match(/^\[([ xX])\]\s*/);
                if (match) {
                  checked = match[1].toLowerCase() === 'x';
                  const cleanedText = textChild.text?.slice(match[0].length) || '';
                  const remainingInline: PMNode[] = [];
                  if (cleanedText) {
                    remainingInline.push(schema.text(cleanedText, textChild.marks));
                  }
                  block.forEach((inlineNode, _off, inlineIndex) => {
                    if (inlineIndex > 0) remainingInline.push(inlineNode);
                  });
                  newChildren.push(schema.nodes['paragraph'].create(block.attrs, remainingInline, block.marks));
                  return;
                }
              }
            }
            newChildren.push(transformTaskLists(block));
          });

          taskItems.push(schema.nodes['task_item'].create({ checked }, newChildren));
        } else {
          taskItems.push(transformTaskLists(child));
        }
      });

      return schema.nodes['task_list'].create(node.attrs, taskItems);
    }
  }

  if (node.isLeaf) return node;

  const transformedChildren: PMNode[] = [];
  node.forEach((child) => {
    transformedChildren.push(transformTaskLists(child));
  });

  return node.copy(Fragment.from(transformedChildren));
}

export function parseMarkdown(content: string): PMNode {
  const doc = markdownParser.parse(content || '') || schema.nodes['doc'].createAndFill()!;
  return transformTaskLists(doc);
}

export function serializeMarkdown(doc: PMNode): string {
  return markdownSerializer.serialize(doc);
}
