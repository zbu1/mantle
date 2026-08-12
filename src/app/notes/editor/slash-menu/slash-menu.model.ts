import { EditorView } from 'prosemirror-view';
import {
  setHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
  toggleBlockquote,
  toggleCodeBlock,
  insertHorizontalRule,
} from '../prosemirror/editor-commands';

export type SlashCommandIcon =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'blockquote'
  | 'code-block'
  | 'divider';

export interface SlashCommandItem {
  id: string;
  label: string;
  icon: SlashCommandIcon;
  keywords: string[];
  run: (view: EditorView) => void;
}

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
];

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMAND_ITEMS;
  return SLASH_COMMAND_ITEMS.filter(
    (item) => item.label.toLowerCase().includes(q) || item.keywords.some((keyword) => keyword.includes(q)),
  );
}
