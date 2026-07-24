export type ContextMenuIcon =
  | 'open'
  | 'open-new-tab'
  | 'copy'
  | 'rename'
  | 'duplicate'
  | 'favorite'
  | 'unfavorite'
  | 'close'
  | 'delete';

export interface ContextMenuAction {
  kind: 'item';
  label: string;
  icon: ContextMenuIcon;
  danger?: boolean;
  action: () => void;
}

export interface ContextMenuSeparator {
  kind: 'separator';
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;
