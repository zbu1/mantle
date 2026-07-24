import { Component, inject, signal } from '@angular/core';
import { LucideClock, LucideLock, LucideStar } from '@lucide/angular';
import { SidebarSection } from './sidebar-section/sidebar-section';
import { SidebarItemButton } from './sidebar-item-button/sidebar-item-button';
import { FAVORITE_NOTES, RECENT_NOTES, TAG_GROUPS, VAULT_NOTES } from '../../notes/notes-data';
import { Note } from '../../notes/note.model';
import { SidebarState } from './sidebar-state';
import { TabsState } from '../../notes/tabs-state';

@Component({
  selector: 'app-sidebar',
  imports: [SidebarSection, SidebarItemButton, LucideStar, LucideClock, LucideLock],
  templateUrl: './sidebar.html',
  host: { class: 'contents' },
})
export class Sidebar {
  protected readonly state = inject(SidebarState);
  private readonly tabsState = inject(TabsState);

  protected readonly favorites = FAVORITE_NOTES;
  protected readonly recentFiles = RECENT_NOTES;
  protected readonly vaultItems = VAULT_NOTES;
  protected readonly tagGroups = TAG_GROUPS;

  private readonly dragStartX = signal<number | null>(null);
  private readonly dragStartWidth = signal<number>(0);

  protected openNote(note: Note): void {
    this.tabsState.openNote(note);
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
