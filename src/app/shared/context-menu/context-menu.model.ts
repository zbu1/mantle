export type ContextMenuIcon =
  | 'open'
  | 'open-new-tab'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'reveal'
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
  disabled?: boolean;
  action: () => void;
}

export interface ContextMenuSeparator {
  kind: 'separator';
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;
