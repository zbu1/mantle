export type CommandPaletteIcon =
  | 'file-search'
  | 'file-plus'
  | 'folder-plus'
  | 'save'
  | 'save-all'
  | 'x'
  | 'layers'
  | 'folders'
  | 'folder-x'
  | 'lock'
  | 'panel-left'
  | 'star'
  | 'clock'
  | 'tags'
  | 'shield-check'
  | 'arrow-left'
  | 'arrow-right'
  | 'expand'
  | 'refresh-cw'
  | 'settings'
  | 'info'
  | 'door-open';

export interface CommandPaletteItem {
  id: string;
  label: string;
  icon: CommandPaletteIcon;
  keywords: string[];
  run: () => void;
}

export function filterCommandPaletteItems(items: CommandPaletteItem[], query: string): CommandPaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) => item.label.toLowerCase().includes(q) || item.keywords.some((keyword) => keyword.includes(q)),
  );
}
