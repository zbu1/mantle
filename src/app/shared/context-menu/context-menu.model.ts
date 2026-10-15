export type ContextMenuIcon =
  | 'open'
  | 'open-new-tab'
  | 'open-external'
  | 'new-note'
  | 'new-folder'
  | 'new-encrypted-note'
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
  | 'unlock'
  | 'convert'
  | 'code'
  | 'paragraph';

export interface ContextMenuAction {
  kind: 'item';
  label: string;
  /** Leading icon. Omit for checkable rows, which show a checkmark (or nothing) in that slot instead. */
  icon?: ContextMenuIcon;
  /** Makes this a checkable row: `true` draws a checkmark in the icon slot, `false` leaves it blank. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Key combination shown at the row's end, e.g. `Ctrl+X`. */
  shortcut?: string;
  action: () => void;
}

export interface ContextMenuSeparator {
  kind: 'separator';
}

/** A row that opens a nested menu beside it (on hover, click, or ArrowRight). One level deep. */
export interface ContextMenuSubmenu {
  kind: 'submenu';
  label: string;
  icon?: ContextMenuIcon;
  items: ContextMenuFlatItem[];
}

/** A row of a menu without submenus, such as a submenu itself. */
export type ContextMenuFlatItem = ContextMenuAction | ContextMenuSeparator;

export type ContextMenuItem = ContextMenuFlatItem | ContextMenuSubmenu;
