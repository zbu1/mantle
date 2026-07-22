export interface FavoriteItem {
  name: string;
}

export interface RecentFileItem {
  name: string;
  timestamp: string;
}

export interface VaultItem {
  name: string;
  count: number;
}

export interface TagItem {
  name: string;
  count: number;
  color: string;
}

export const FAVORITES: FavoriteItem[] = [
  { name: 'Project Roadmap' },
  { name: 'Meeting Notes — Q3' },
  { name: 'Reading List' },
];

export const RECENT_FILES: RecentFileItem[] = [
  { name: 'daily-standup.md', timestamp: '2h ago' },
  { name: 'architecture-notes.md', timestamp: '5h ago' },
  { name: 'todo.md', timestamp: 'Yesterday' },
  { name: 'ideas.md', timestamp: '2d ago' },
  { name: 'changelog.md', timestamp: '4d ago' },
];

export const VAULT_ITEMS: VaultItem[] = [
  { name: 'Personal', count: 24 },
  { name: 'Work', count: 58 },
  { name: 'Archive', count: 12 },
];

export const TAGS: TagItem[] = [
  { name: 'urgent', count: 4, color: '#ef4444' },
  { name: 'idea', count: 9, color: '#eab308' },
  { name: 'reference', count: 15, color: '#396cd8' },
  { name: 'draft', count: 6, color: '#a855f7' },
  { name: 'archived', count: 21, color: '#6b6b6b' },
];
