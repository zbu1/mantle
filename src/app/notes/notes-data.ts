import { NoteRef } from './note.model';

export interface NoteTag {
  name: string;
  color: string;
}

export interface MockNote extends NoteRef {
  favorite: boolean;
  folder: string;
  tags: NoteTag[];
  updatedAt: string;
}

const TAG_DEFS: Record<string, NoteTag> = {
  urgent: { name: 'urgent', color: '#ef4444' },
  idea: { name: 'idea', color: '#eab308' },
  reference: { name: 'reference', color: '#396cd8' },
  draft: { name: 'draft', color: '#a855f7' },
  archived: { name: 'archived', color: '#6b6b6b' },
};

export const MOCK_NOTES: MockNote[] = [
  {
    id: 'project-roadmap',
    title: 'Project Roadmap',
    favorite: true,
    folder: 'Work',
    tags: [TAG_DEFS['reference']],
    updatedAt: '3d ago',
  },
  {
    id: 'meeting-notes-q3',
    title: 'Meeting Notes — Q3',
    favorite: true,
    folder: 'Work',
    tags: [TAG_DEFS['reference'], TAG_DEFS['urgent']],
    updatedAt: '6d ago',
  },
  {
    id: 'reading-list',
    title: 'Reading List',
    favorite: true,
    folder: 'Personal',
    tags: [TAG_DEFS['idea']],
    updatedAt: '2w ago',
  },
  {
    id: 'daily-standup',
    title: 'daily-standup.md',
    favorite: false,
    folder: 'Work',
    tags: [TAG_DEFS['urgent']],
    updatedAt: '2h ago',
  },
  {
    id: 'architecture-notes',
    title: 'architecture-notes.md',
    favorite: false,
    folder: 'Work',
    tags: [TAG_DEFS['reference']],
    updatedAt: '5h ago',
  },
  {
    id: 'todo',
    title: 'todo.md',
    favorite: false,
    folder: 'Personal',
    tags: [TAG_DEFS['urgent'], TAG_DEFS['draft']],
    updatedAt: 'Yesterday',
  },
  {
    id: 'ideas',
    title: 'ideas.md',
    favorite: false,
    folder: 'Personal',
    tags: [TAG_DEFS['idea'], TAG_DEFS['draft']],
    updatedAt: '2d ago',
  },
  {
    id: 'changelog',
    title: 'changelog.md',
    favorite: false,
    folder: 'Archive',
    tags: [TAG_DEFS['archived']],
    updatedAt: '4d ago',
  },
];

const notesById = new Map(MOCK_NOTES.map((note) => [note.id, note]));

function notesByIds(ids: string[]): MockNote[] {
  return ids.map((id) => notesById.get(id)).filter((note): note is MockNote => !!note);
}

export const FAVORITE_NOTES: MockNote[] = MOCK_NOTES.filter((note) => note.favorite);

export const RECENT_NOTES: MockNote[] = notesByIds([
  'daily-standup',
  'architecture-notes',
  'todo',
  'ideas',
  'changelog',
]);

export interface TagGroup {
  name: string;
  color: string;
  notes: MockNote[];
}

export const TAG_GROUPS: TagGroup[] = Object.values(TAG_DEFS).map((tag) => ({
  name: tag.name,
  color: tag.color,
  notes: MOCK_NOTES.filter((note) => note.tags.some((t) => t.name === tag.name)),
}));
