import { Note, NoteTag } from './note.model';

const TAG_DEFS: Record<string, NoteTag> = {
  urgent: { name: 'urgent', color: '#ef4444' },
  idea: { name: 'idea', color: '#eab308' },
  reference: { name: 'reference', color: '#396cd8' },
  draft: { name: 'draft', color: '#a855f7' },
  archived: { name: 'archived', color: '#6b6b6b' },
};

export const MOCK_NOTES: Note[] = [
  {
    id: 'project-roadmap',
    title: 'Project Roadmap',
    content: 'Q3 milestones, ownership, and target dates for the roadmap.',
    favorite: true,
    folder: 'Work',
    tags: [TAG_DEFS['reference']],
    updatedAt: '3d ago',
  },
  {
    id: 'meeting-notes-q3',
    title: 'Meeting Notes — Q3',
    content: 'Notes from the Q3 planning meeting: decisions, action items, follow-ups.',
    favorite: true,
    folder: 'Work',
    tags: [TAG_DEFS['reference'], TAG_DEFS['urgent']],
    updatedAt: '6d ago',
  },
  {
    id: 'reading-list',
    title: 'Reading List',
    content: 'Articles and books to get through this quarter.',
    favorite: true,
    folder: 'Personal',
    tags: [TAG_DEFS['idea']],
    updatedAt: '2w ago',
  },
  {
    id: 'daily-standup',
    title: 'daily-standup.md',
    content: 'Yesterday: shipped the sidebar resize handle. Today: tab strip. Blockers: none.',
    favorite: false,
    folder: 'Work',
    tags: [TAG_DEFS['urgent']],
    updatedAt: '2h ago',
  },
  {
    id: 'architecture-notes',
    title: 'architecture-notes.md',
    content: 'Notes on the layout shell: header, sidebar, and the tabbed content area.',
    favorite: false,
    folder: 'Work',
    tags: [TAG_DEFS['reference']],
    updatedAt: '5h ago',
  },
  {
    id: 'todo',
    title: 'todo.md',
    content: '- Wire up sidebar clicks to open tabs\n- Persist open tabs\n- Empty state for no tabs',
    favorite: false,
    folder: 'Personal',
    tags: [TAG_DEFS['urgent'], TAG_DEFS['draft']],
    updatedAt: 'Yesterday',
  },
  {
    id: 'ideas',
    title: 'ideas.md',
    content: 'Random ideas: quick-switcher, split panes, note linking.',
    favorite: false,
    folder: 'Personal',
    tags: [TAG_DEFS['idea'], TAG_DEFS['draft']],
    updatedAt: '2d ago',
  },
  {
    id: 'changelog',
    title: 'changelog.md',
    content: 'v0.3 — sidebar theming, resizable width.\nv0.2 — application header.\nv0.1 — scaffold.',
    favorite: false,
    folder: 'Archive',
    tags: [TAG_DEFS['archived']],
    updatedAt: '4d ago',
  },
];

const notesById = new Map(MOCK_NOTES.map((note) => [note.id, note]));

export function findNote(id: string): Note | undefined {
  return notesById.get(id);
}

function notesByIds(ids: string[]): Note[] {
  return ids.map((id) => notesById.get(id)).filter((note): note is Note => !!note);
}

export const FAVORITE_NOTES: Note[] = MOCK_NOTES.filter((note) => note.favorite);

export const RECENT_NOTES: Note[] = notesByIds([
  'daily-standup',
  'architecture-notes',
  'todo',
  'ideas',
  'changelog',
]);

export const VAULT_NOTES: Note[] = MOCK_NOTES;

export interface TagGroup {
  name: string;
  color: string;
  notes: Note[];
}

export const TAG_GROUPS: TagGroup[] = Object.values(TAG_DEFS).map((tag) => ({
  name: tag.name,
  color: tag.color,
  notes: MOCK_NOTES.filter((note) => note.tags.some((t) => t.name === tag.name)),
}));
