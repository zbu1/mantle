import { Component, computed, inject } from '@angular/core';
import { LucideX } from '@lucide/angular';
import { TabsState } from '../../../notes/tabs-state';
import { findNote } from '../../../notes/notes-data';
import { ContextMenuState } from '../../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../../shared/context-menu/context-menu.model';

@Component({
  selector: 'app-content-area',
  imports: [LucideX],
  templateUrl: './content-area.html',
})
export class ContentArea {
  protected readonly tabsState = inject(TabsState);
  private readonly contextMenuState = inject(ContextMenuState);

  protected readonly activeNote = computed(() => {
    const activeId = this.tabsState.activeId();
    const tab = activeId ? this.tabsState.tabs().find((t) => t.id === activeId) : undefined;
    return tab ? findNote(tab.noteId) : undefined;
  });

  protected activateTab(id: string): void {
    this.tabsState.setActive(id);
  }

  protected closeTab(event: Event, id: string): void {
    event.stopPropagation();
    this.tabsState.closeTab(id);
  }

  protected onContentContextMenu(event: MouseEvent): void {
    const note = this.activeNote();
    const activeId = this.tabsState.activeId();
    if (!note || !activeId) return;

    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Copy Content', icon: 'copy', action: () => navigator.clipboard.writeText(note.content) },
      { kind: 'item', label: 'Copy Title', icon: 'copy', action: () => navigator.clipboard.writeText(note.title) },
      { kind: 'separator' },
      { kind: 'item', label: 'Rename Note', icon: 'rename', action: () => {} },
      { kind: 'item', label: 'Duplicate Note', icon: 'duplicate', action: () => {} },
      { kind: 'separator' },
      { kind: 'item', label: 'Close Tab', icon: 'close', action: () => this.tabsState.closeTab(activeId) },
      { kind: 'item', label: 'Delete Note', icon: 'delete', danger: true, action: () => {} },
    ];
    this.contextMenuState.open(event, items);
  }
}
