import { Injectable, inject } from '@angular/core';
import { ContextMenuState } from '../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../shared/context-menu/context-menu.model';
import { SidebarState } from '../layout/sidebar/sidebar-state';
import { FavoritesState } from './favorites-state';
import { NotePropertiesState } from './note-properties-state';
import { NotesState } from './notes-state';
import { ToastState } from '../shared/toast/toast-state';
import { NoteShowingTab, NoteTab, TabsState } from './tabs-state';
import { VaultMetaState } from './vault-meta-state';
import { VaultSelectionState } from './vault-selection-state';
import { VaultState } from './vault-state';
import { flattenTreeNodes, isNotePath } from './vault-tree.model';

/**
 * The menu for a tab: its own context menu, and the note toolbar's More
 * button for the active one.
 */
@Injectable({ providedIn: 'root' })
export class TabMenu {
  private readonly tabsState = inject(TabsState);
  private readonly toast = inject(ToastState);
  private readonly notesState = inject(NotesState);
  private readonly vaultState = inject(VaultState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly favorites = inject(FavoritesState);
  private readonly sidebarState = inject(SidebarState);
  private readonly selectionState = inject(VaultSelectionState);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly noteProperties = inject(NotePropertiesState);

  open(event: MouseEvent, shown: NoteTab): void {
    // The tab's own pane's tabs.
    const pane = this.tabsState.paneOf(shown.id);
    const tabs = pane ? this.tabsState.tabsOf(pane.id) : [shown];
    const index = tabs.findIndex((t) => t.id === shown.id);
    const closeAll = (keep: (t: NoteTab, i: number) => boolean) => () =>
      tabs.forEach((t, i) => !keep(t, i) && this.tabsState.closeTab(t.id));
    const closeItems: ContextMenuItem[] = [
      { kind: 'item', label: 'Close', icon: 'close', shortcut: 'Ctrl+W', action: () => this.tabsState.closeTab(shown.id) },
      { kind: 'item', label: 'Close Others', disabled: tabs.length < 2, action: closeAll((t) => t.id === shown.id) },
      { kind: 'item', label: 'Close to the Right', disabled: index === tabs.length - 1, action: closeAll((_t, i) => i <= index) },
      { kind: 'item', label: 'Close All', action: closeAll(() => false) },
    ];
    if (shown.noteId === null) {
      this.contextMenuState.open(event, closeItems);
      return;
    }
    const tab = shown as NoteShowingTab;
    const isNote = isNotePath(tab.noteId);
    const tree = this.vaultState.tree();
    const exists = !!tree && flattenTreeNodes(tree).has(tab.noteId);
    const content = this.notesState.getNote(tab.noteId)?.content;

    const items: ContextMenuItem[] = [
      ...closeItems,
      { kind: 'separator' },
      {
        kind: 'item',
        desktopOnly: true,
        label: 'Open to the Right',
        action: () => this.tabsState.openBeside({ id: tab.noteId, title: tab.title }, 'row', pane?.id),
      },
      {
        kind: 'item',
        desktopOnly: true,
        label: 'Open Below',
        action: () => this.tabsState.openBeside({ id: tab.noteId, title: tab.title }, 'column', pane?.id),
      },
      {
        kind: 'item',
        label: 'Show Backlinks',
        disabled: !isNote || !exists,
        action: () => {
          this.tabsState.setActive(tab.id);
          this.noteProperties.showBacklinks(tab.noteId);
        },
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Copy Path', icon: 'copy', action: () => this.toast.copy(tab.noteId) },
      { kind: 'item', label: 'Copy Title', action: () => this.toast.copy(tab.title) },
      ...(isNote
        ? [{ kind: 'item' as const, label: 'Copy Content', disabled: content === undefined, action: () => this.toast.copy(content ?? '') }]
        : []),
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Reveal in Sidebar',
        disabled: !exists,
        action: () => {
          this.selectionState.selectOnly(tab.noteId);
          this.sidebarState.revealItem(tab.noteId);
        },
      },
      {
        kind: 'item',
        desktopOnly: true,
        label: 'Show in File Explorer',
        icon: 'reveal',
        disabled: !exists,
        action: () => void this.vaultState.revealInFileExplorer(tab.noteId),
      },
    ];
    if (isNote && exists) {
      items.push({ kind: 'separator' }, { kind: 'item', label: 'Rename', icon: 'rename', action: () => this.rename(tab) });
      // Not for a Markdown file whose frontmatter can't be read (null), which is left alone.
      const editable = !!this.notesState.getNote(tab.noteId)?.properties;
      const add = (kind: 'property' | 'tag') => () => {
        this.tabsState.setActive(tab.id);
        this.noteProperties.requestAdd(tab.noteId, kind);
      };
      items.push(
        { kind: 'item', label: 'Add Property', disabled: !editable, action: add('property') },
        { kind: 'item', label: 'Add Tag', disabled: !editable, action: add('tag') },
      );
      if (this.vaultMeta.loaded()) {
        const favorite = this.favorites.isFavorite(tab.noteId);
        items.push({
          kind: 'item',
          label: favorite ? 'Remove from Favorites' : 'Add to Favorites',
          icon: favorite ? 'unfavorite' : 'favorite',
          shortcut: 'Ctrl+Shift+B',
          action: () => this.favorites.toggle(tab.noteId),
        });
      }
    }
    this.contextMenuState.open(event, items);
  }

  /** Renaming happens in the note's title field, above its editor. */
  private rename(tab: NoteTab): void {
    this.tabsState.setActive(tab.id);
    focusNoteTitle();
  }
}

/** Focuses and selects the active note's title field once it has rendered. */
export function focusNoteTitle(): void {
  setTimeout(() => {
    const title = document.querySelector<HTMLTextAreaElement>('[data-note-title]');
    title?.focus();
    title?.select();
  });
}
