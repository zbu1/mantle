import { Schema, NodeSpec, MarkSpec, Node as PMNode, Mark as PMMark } from 'prosemirror-model';
import OrderedMap from 'orderedmap';
import { addListNodes } from 'prosemirror-schema-list';

const baseNodes = OrderedMap.from<NodeSpec>({
  doc: {
    content: 'block+',
  },
  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM() {
      return ['p', 0];
    },
  },
  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM() {
      return ['blockquote', 0];
    },
  },
  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM() {
      return ['hr'];
    },
  },
  heading: {
    attrs: { level: { default: 1 } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [
      { tag: 'h1', attrs: { level: 1 } },
      { tag: 'h2', attrs: { level: 2 } },
      { tag: 'h3', attrs: { level: 3 } },
    ],
    toDOM(node: PMNode) {
      return ['h' + node.attrs['level'], 0];
    },
  },
  code_block: {
    attrs: { params: { default: '' } },
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM() {
      return ['pre', ['code', 0]];
    },
  },
  text: {
    group: 'inline',
  },
  hard_break: {
    group: 'inline',
    inline: true,
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM() {
      return ['br'];
    },
  },
  task_list: {
    content: 'task_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul[data-type="taskList"]' }],
    toDOM() {
      return ['ul', { 'data-type': 'taskList', class: 'task-list list-none p-0' }, 0];
    },
  },
  task_item: {
    attrs: { checked: { default: false } },
    content: 'paragraph block*',
    defining: true,
    parseDOM: [
      {
        tag: 'li[data-type="taskItem"]',
        getAttrs: (dom: string | Node) => ({
          checked: (dom as HTMLElement).getAttribute?.('data-checked') === 'true',
        }),
      },
    ],
    toDOM(node: PMNode) {
      return [
        'li',
        {
          'data-type': 'taskItem',
          'data-checked': node.attrs['checked'] ? 'true' : 'false',
          class: 'flex items-start gap-2 my-1',
        },
        0,
      ];
    },
  },
});

const nodesWithLists = addListNodes(baseNodes, 'paragraph block*', 'block');

export const marks: Record<string, MarkSpec> = {
  em: {
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    toDOM() {
      return ['em', 0];
    },
  },
  strong: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight=bold' }],
    toDOM() {
      return ['strong', 0];
    },
  },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'strike' }, { style: 'text-decoration=line-through' }],
    toDOM() {
      return ['s', 0];
    },
  },
  code: {
    // prosemirror-inputrules keys its code guard off `spec.code`, not the mark
    // name, so this flag is what stops input rules firing inside code spans.
    code: true,
    parseDOM: [{ tag: 'code' }],
    toDOM() {
      return ['code', 0];
    },
  },
  link: {
    attrs: {
      href: {},
      title: { default: null },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs(dom: string | Node) {
          const el = dom as HTMLElement;
          return {
            href: el.getAttribute?.('href'),
            title: el.getAttribute?.('title'),
          };
        },
      },
    ],
    toDOM(mark: PMMark) {
      return ['a', { href: mark.attrs['href'], title: mark.attrs['title'] }, 0];
    },
  },
};

export const schema = new Schema({
  nodes: nodesWithLists,
  marks,
});
