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

/** The items for `recentPaths`, in that order, skipping paths with no matching item. */
function recentItemsInOrder(items: QuickSwitcherItem[], recentPaths: readonly string[]): QuickSwitcherItem[] {
  const byPath = new Map(items.map((item) => [item.note.relPath, item]));
  return recentPaths.flatMap((relPath) => {
    const item = byPath.get(relPath);
    return item ? [item] : [];
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

/**
 * Filters `items` by `query`. `recentPaths` (most recent first) shapes the
 * empty-query view: recents come first, followed by every other note in its
 * original order — or, with `recentsOnly`, nothing else. A typed query ranks
 * purely by match quality, though `recentsOnly` still confines it to recents.
 */
export function filterQuickSwitcherItems(
  items: QuickSwitcherItem[],
  query: string,
  recentPaths: readonly string[] = [],
  recentsOnly = false,
): QuickSwitcherItem[] {
  const q = query.trim().toLowerCase();
  const recents = recentItemsInOrder(items, recentPaths);

  if (!q) {
    if (recentsOnly) return recents;
    const recentSet = new Set(recentPaths);
    return [...recents, ...items.filter((item) => !recentSet.has(item.note.relPath))];
  }

  return (recentsOnly ? recents : items)
    .map((item) => ({ item, rank: matchRank(item, q) }))
    .filter((entry): entry is { item: QuickSwitcherItem; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.item.note.name.localeCompare(b.item.note.name))
    .map((entry) => entry.item);
}
