import markdownIt from 'markdown-it';
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown';
import { Node as PMNode, Fragment } from 'prosemirror-model';
import { schema } from './schema';

const md = markdownIt('commonmark', { html: false });
md.enable('strikethrough');

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
  hr: { node: 'horizontal_rule' },
  hardbreak: { node: 'hard_break' },

  em: { mark: 'em' },
  strong: { mark: 'strong' },
  s: { mark: 'strike' },
  link: {
    mark: 'link',
    getAttrs: (tok) => ({
      href: tok.attrGet('href'),
      title: tok.attrGet('title') || null,
    }),
  },
  code_inline: { mark: 'code', noCloseToken: true },
});

export const markdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    task_list(state, node) {
      state.renderList(node, '  ', () => '- ');
    },
    task_item(state, node) {
      state.write(node.attrs['checked'] ? '[x] ' : '[ ] ');
      state.renderContent(node);
    },
    horizontal_rule(state, node) {
      state.write(node.attrs['markup'] || '---');
      state.closeBlock(node);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
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
