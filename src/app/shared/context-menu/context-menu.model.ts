export type ContextMenuIcon =
  | 'open'
  | 'open-new-tab'
  | 'new-note'
  | 'new-folder'
  | 'new-profile'
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
  | 'check'
  | 'lock'
  | 'unlock';

export interface ContextMenuAction {
  kind: 'item';
  label: string;
  /** Leading icon. Omit for checkable rows, which show a checkmark (or nothing) in that slot instead. */
  icon?: ContextMenuIcon;
  /** Makes this a checkable row: `true` draws a checkmark in the icon slot, `false` leaves it blank. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  action: () => void;
}

export interface ContextMenuSeparator {
  kind: 'separator';
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;
