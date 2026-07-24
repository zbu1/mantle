import { Component, inject, signal } from '@angular/core';
import { LucideClock, LucideFileText, LucideFolders, LucideStar, LucideTags } from '@lucide/angular';
import { SidebarSection } from './sidebar-section/sidebar-section';
import { SidebarItemButton } from './sidebar-item-button/sidebar-item-button';
import { FAVORITE_NOTES, RECENT_NOTES, TAG_GROUPS, VAULT_NOTES } from '../../notes/notes-data';
import { Note } from '../../notes/note.model';
import { SidebarState } from './sidebar-state';
import { TabsState } from '../../notes/tabs-state';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../shared/context-menu/context-menu.model';

@Component({
  selector: 'app-sidebar',
  imports: [SidebarSection, SidebarItemButton, LucideStar, LucideClock, LucideFolders, LucideTags, LucideFileText],
  templateUrl: './sidebar.html',
  host: { class: 'contents' },
})
export class Sidebar {
  protected readonly state = inject(SidebarState);
  private readonly tabsState = inject(TabsState);
  private readonly contextMenuState = inject(ContextMenuState);

  protected readonly favorites = FAVORITE_NOTES;
  protected readonly recentFiles = RECENT_NOTES;
  protected readonly vaultItems = VAULT_NOTES;
  protected readonly tagGroups = TAG_GROUPS;

  private readonly dragStartX = signal<number | null>(null);
  private readonly dragStartWidth = signal<number>(0);

  protected openNote(note: Note): void {
    this.tabsState.openNote(note);
  }

  protected openNoteInBackground(note: Note): void {
    this.tabsState.openNoteInBackground(note);
  }

  protected openNoteContextMenu(event: MouseEvent, note: Note): void {
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Open', icon: 'open', action: () => this.openNote(note) },
      { kind: 'item', label: 'Open in New Tab', icon: 'open-new-tab', action: () => this.openNoteInBackground(note) },
      { kind: 'separator' },
      { kind: 'item', label: 'Rename', icon: 'rename', action: () => {} },
      { kind: 'item', label: 'Duplicate', icon: 'duplicate', action: () => {} },
      {
        kind: 'item',
        label: note.favorite ? 'Remove from Favorites' : 'Add to Favorites',
        icon: note.favorite ? 'unfavorite' : 'favorite',
        action: () => {},
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Delete', icon: 'delete', danger: true, action: () => {} },
    ];
    this.contextMenuState.open(event, items);
  }

  protected onResizePointerDown(event: PointerEvent): void {
    if (this.state.collapsed()) return;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    this.dragStartX.set(event.clientX);
    this.dragStartWidth.set(this.state.width());
  }

  protected onResizePointerMove(event: PointerEvent): void {
    const startX = this.dragStartX();
    if (startX === null) return;
    const delta = event.clientX - startX;
    this.state.setWidth(this.dragStartWidth() + delta);
  }

  protected onResizePointerUp(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    handle.releasePointerCapture(event.pointerId);
    this.dragStartX.set(null);
  }
}
