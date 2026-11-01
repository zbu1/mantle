import { EditorView } from 'prosemirror-view';
import {
  setHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
  toggleBlockquote,
  toggleCodeBlock,
  insertHorizontalRule,
  insertTableOfContents,
} from '../prosemirror/editor-commands';
import { insertTable } from '../prosemirror/plugins/table-plugin';
import { pickImage } from '../prosemirror/plugins/image-plugin';
import { setCodeBlock } from '../prosemirror/plugins/code-block-plugin';
import { matchLanguages } from '../prosemirror/code-languages';

export type SlashCommandIcon =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'blockquote'
  | 'code-block'
  | 'divider'
  | 'table'
  | 'toc'
  | 'image'
  | 'property'
  | 'tag';

export interface SlashCommandItem {
  id: string;
  label: string;
  icon: SlashCommandIcon;
  keywords: string[];
  run: (view: EditorView) => void;
}

/** Asks the editor's note to start adding a property or (`detail: 'tag'`) a tag. */
export const ADD_PROPERTY_EVENT = 'mantle-add-property';

export const SLASH_COMMAND_ITEMS: SlashCommandItem[] = [
  {
    id: 'h1',
    label: 'Heading 1',
    icon: 'h1',
    keywords: ['heading', 'h1', 'title'],
    run: (view) => setHeading(view, 1),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    icon: 'h2',
    keywords: ['heading', 'h2', 'subtitle'],
    run: (view) => setHeading(view, 2),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    icon: 'h3',
    keywords: ['heading', 'h3'],
    run: (view) => setHeading(view, 3),
  },
  {
    id: 'bullet-list',
    label: 'Bullet List',
    icon: 'bullet-list',
    keywords: ['bullet', 'list', 'ul'],
    run: (view) => toggleBulletList(view),
  },
  {
    id: 'ordered-list',
    label: 'Numbered List',
    icon: 'ordered-list',
    keywords: ['ordered', 'numbered', 'list', 'ol'],
    run: (view) => toggleOrderedList(view),
  },
  {
    id: 'task-list',
    label: 'To-do List',
    icon: 'task-list',
    keywords: ['task', 'todo', 'to-do', 'checkbox', 'checklist'],
    run: (view) => toggleTaskList(view),
  },
  {
    id: 'blockquote',
    label: 'Blockquote',
    icon: 'blockquote',
    keywords: ['blockquote', 'quote'],
    run: (view) => toggleBlockquote(view),
  },
  {
    id: 'code-block',
    label: 'Code Block',
    icon: 'code-block',
    keywords: ['code', 'codeblock', 'pre'],
    run: (view) => toggleCodeBlock(view),
  },
  {
    id: 'divider',
    label: 'Divider',
    icon: 'divider',
    keywords: ['divider', 'hr', 'horizontal', 'rule', 'line'],
    run: (view) => insertHorizontalRule(view),
  },
  {
    id: 'table',
    label: 'Table',
    icon: 'table',
    keywords: ['table', 'grid', 'columns', 'rows'],
    run: (view) => insertTable(view),
  },
  {
    id: 'toc',
    label: 'Table of Contents',
    icon: 'toc',
    keywords: ['toc', 'contents', 'outline'],
    run: (view) => insertTableOfContents(view),
  },
  {
    id: 'image',
    label: 'Image, Video or PDF',
    icon: 'image',
    keywords: ['image', 'picture', 'photo', 'img', 'video', 'movie', 'pdf', 'document', 'embed'],
    run: (view) => void pickImage(view),
  },
  // The note's properties panel lives outside the editor; `NoteEditor` hears these.
  {
    id: 'property',
    label: 'Add Property',
    icon: 'property',
    keywords: ['property', 'properties', 'frontmatter', 'metadata', 'field'],
    run: (view) => void view.dom.dispatchEvent(new CustomEvent(ADD_PROPERTY_EVENT, { detail: 'property' })),
  },
  {
    id: 'tag',
    label: 'Add Tag',
    icon: 'tag',
    keywords: ['tag', 'tags', 'label'],
    run: (view) => void view.dom.dispatchEvent(new CustomEvent(ADD_PROPERTY_EVENT, { detail: 'tag' })),
  },
];

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const language = /^code (.*)$/i.exec(query);
  if (language) {
    return matchLanguages(language[1]).map((lang) => ({
      id: `code-block-${lang.id}`,
      label: `Code Block: ${lang.name}`,
      icon: 'code-block',
      keywords: [],
      run: (view) => void setCodeBlock(view, lang.id),
    }));
  }
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMAND_ITEMS;
  return SLASH_COMMAND_ITEMS.filter(
    (item) => item.label.toLowerCase().includes(q) || item.keywords.some((keyword) => keyword.includes(q)),
  );
}
