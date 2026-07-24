import type { ChainedCommands } from '@tiptap/core';

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
  run: (chain: ChainedCommands) => ChainedCommands;
}

export const SLASH_COMMAND_ITEMS: SlashCommandItem[] = [
  {
    id: 'h1',
    label: 'Heading 1',
    icon: 'h1',
    keywords: ['heading', 'h1', 'title'],
    run: (chain) => chain.setHeading({ level: 1 }),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    icon: 'h2',
    keywords: ['heading', 'h2', 'subtitle'],
    run: (chain) => chain.setHeading({ level: 2 }),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    icon: 'h3',
    keywords: ['heading', 'h3'],
    run: (chain) => chain.setHeading({ level: 3 }),
  },
  {
    id: 'bullet-list',
    label: 'Bullet List',
    icon: 'bullet-list',
    keywords: ['bullet', 'list', 'ul'],
    run: (chain) => chain.toggleBulletList(),
  },
  {
    id: 'ordered-list',
    label: 'Numbered List',
    icon: 'ordered-list',
    keywords: ['ordered', 'numbered', 'list', 'ol'],
    run: (chain) => chain.toggleOrderedList(),
  },
  {
    id: 'task-list',
    label: 'Task List',
    icon: 'task-list',
    keywords: ['task', 'todo', 'checkbox', 'checklist'],
    run: (chain) => chain.toggleTaskList(),
  },
  {
    id: 'blockquote',
    label: 'Blockquote',
    icon: 'blockquote',
    keywords: ['blockquote', 'quote'],
    run: (chain) => chain.toggleBlockquote(),
  },
  {
    id: 'code-block',
    label: 'Code Block',
    icon: 'code-block',
    keywords: ['code', 'codeblock', 'pre'],
    run: (chain) => chain.toggleCodeBlock(),
  },
  {
    id: 'divider',
    label: 'Divider',
    icon: 'divider',
    keywords: ['divider', 'hr', 'horizontal', 'rule', 'line'],
    run: (chain) => chain.setHorizontalRule(),
  },
];

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMAND_ITEMS;
  return SLASH_COMMAND_ITEMS.filter(
    (item) => item.label.toLowerCase().includes(q) || item.keywords.some((keyword) => keyword.includes(q)),
  );
}
