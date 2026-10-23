import { Schema, NodeSpec, MarkSpec, Node as PMNode, Mark as PMMark } from 'prosemirror-model';
import OrderedMap from 'orderedmap';
import { addListNodes } from 'prosemirror-schema-list';

const baseNodes = OrderedMap.from<NodeSpec>({
  doc: {
    content: 'block+',
    // The note's tags and properties, kept on the doc so editing them joins
    // the editor's undo history along with its text. See `NotePropertiesState`.
    attrs: { tags: { default: [] }, properties: { default: [] } },
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
    // The `---` / `***` / `___` the file used, so it saves (and reveals) as written.
    attrs: { markup: { default: '---' } },
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM() {
      return ['hr'];
    },
  },
  heading: {
    // As the file wrote it: `underline` is a setext heading's `===` / `---`, `closing` an ATX heading's trailing ` ##`.
    attrs: { level: { default: 1 }, underline: { default: null }, closing: { default: '' } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM(node: PMNode) {
      return ['h' + node.attrs['level'], 0];
    },
  },
  code_block: {
    // `revealed`: the cursor is in it, so its fence lines are part of its text (see syntax-reveal-plugin).
    // `fence`: the ``` or ~~~ the file used, or '' for indented code.
    attrs: { params: { default: '' }, revealed: { default: false }, fence: { default: '```' } },
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
  image: {
    inline: true,
    group: 'inline',
    draggable: true,
    attrs: {
      src: {},
      alt: { default: null },
      title: { default: null },
      // Obsidian's `![[src|size]]` embed: `embed` keeps that syntax on save,
      // `size` is its "300" or "300x200".
      embed: { default: false },
      size: { default: null },
    },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom: string | Node) => {
          const el = dom as HTMLElement;
          return { src: el.getAttribute('src'), alt: el.getAttribute('alt'), title: el.getAttribute('title') };
        },
      },
    ],
    toDOM(node: PMNode) {
      const { src, alt, title } = node.attrs;
      return ['img', { src, alt, title }];
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

// `tight` (no blank lines between items) and the marker the file used, so lists save as written.
const listAttrs = { tight: { default: true }, bullet: { default: '-' } };
const withListNodes = addListNodes(baseNodes, 'paragraph block*', 'block');
const nodesWithLists = withListNodes
  .update('bullet_list', { ...withListNodes.get('bullet_list')!, attrs: listAttrs })
  .update('ordered_list', {
    ...withListNodes.get('ordered_list')!,
    attrs: { order: { default: 1 }, tight: { default: true }, delimiter: { default: '.' } },
  })
  .update('task_list', { ...withListNodes.get('task_list')!, attrs: listAttrs });

export const marks: Record<string, MarkSpec> = {
  // `markup` is the delimiter the file used (`*` or `_`), so it saves as written.
  em: {
    attrs: { markup: { default: '*' } },
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    toDOM() {
      return ['em', 0];
    },
  },
  strong: {
    attrs: { markup: { default: '**' } },
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
  // A `[[target#heading|alias]]` link to another note (or `![[…]]`, an embed
  // of one, shown as a link). Its text is the alias, or else the target as
  // written, so the link saves verbatim.
  wikilink: {
    attrs: { target: {}, alias: { default: false }, embed: { default: false } },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a.wikilink[data-target]',
        getAttrs: (dom: string | Node) => ({ target: (dom as HTMLElement).dataset['target'] }),
      },
    ],
    toDOM(mark: PMMark) {
      return ['a', { class: 'wikilink', 'data-target': mark.attrs['target'] }, 0];
    },
  },
  // Raw Markdown shown while the cursor is in a construct (see syntax-reveal-plugin).
  // Saved verbatim; `image` marks an image's source, shown just before the image it stands for.
  // Inclusive, so what's typed straight after it stays raw until the cursor leaves.
  md_raw: {
    attrs: { image: { default: false } },
    excludes: '_',
    // Keeps the inline input rules from firing inside it.
    code: true,
    parseDOM: [{ tag: 'span.md-raw' }],
    toDOM(mark: PMMark) {
      return ['span', { class: mark.attrs['image'] ? 'md-raw md-raw-image' : 'md-raw' }, 0];
    },
  },
  // A revealed `## ` / `> ` line prefix. Never saved: the block's type says the same.
  md_prefix: {
    inclusive: false,
    excludes: '_',
    code: true,
    toDOM() {
      return ['span', { class: 'md-syntax' }, 0];
    },
  },
};

export const schema = new Schema({
  nodes: nodesWithLists,
  marks,
});
