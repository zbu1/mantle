export type ContextMenuIcon =
  | 'open'
  | 'open-new-tab'
  | 'new-note'
  | 'new-folder'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'reveal'
  | 'rename'
  | 'duplicate'
  | 'move-to-root'
  | 'favorite'
  | 'unfavorite'
  | 'close'
  | 'delete'
  | 'vault'
  | 'check';

export interface ContextMenuAction {
  kind: 'item';
  label: string;
  icon: ContextMenuIcon;
  danger?: boolean;
  disabled?: boolean;
  action: () => void;
}

export interface ContextMenuSeparator {
  kind: 'separator';
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;
