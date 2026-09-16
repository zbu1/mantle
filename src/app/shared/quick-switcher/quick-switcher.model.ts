import { VaultNoteNode } from '../../notes/vault-tree.model';

export interface QuickSwitcherItem {
  note: VaultNoteNode;
  /** Containing folder path, '' for a note at the vault root. */
  dir: string;
}

export function toQuickSwitcherItems(notes: VaultNoteNode[]): QuickSwitcherItem[] {
  return notes.map((note) => {
    const slash = note.relPath.lastIndexOf('/');
    return { note, dir: slash === -1 ? '' : note.relPath.slice(0, slash) };
  });
}

/**
 * Ranks by where the query hit — exact name, name prefix, name substring,
 * then a path substring — rather than true fuzzy matching, matching
 * `filterSlashCommands`'s substring approach elsewhere in the app.
 */
function matchRank(item: QuickSwitcherItem, query: string): number | null {
  const name = item.note.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (item.note.relPath.toLowerCase().includes(query)) return 3;
  return null;
}

export function filterQuickSwitcherItems(items: QuickSwitcherItem[], query: string): QuickSwitcherItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items
    .map((item) => ({ item, rank: matchRank(item, q) }))
    .filter((entry): entry is { item: QuickSwitcherItem; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.item.note.name.localeCompare(b.item.note.name))
    .map((entry) => entry.item);
}
