import { Component, computed, inject } from '@angular/core';
import { LucideX } from '@lucide/angular';
import { TabsState } from '../../../notes/tabs-state';
import { findNote } from '../../../notes/notes-data';

@Component({
  selector: 'app-content-area',
  imports: [LucideX],
  templateUrl: './content-area.html',
})
export class ContentArea {
  protected readonly tabsState = inject(TabsState);

  protected readonly activeNote = computed(() => {
    const activeId = this.tabsState.activeId();
    return activeId ? findNote(activeId) : undefined;
  });

  protected activateTab(id: string): void {
    this.tabsState.setActive(id);
  }

  protected closeTab(event: Event, id: string): void {
    event.stopPropagation();
    this.tabsState.closeTab(id);
  }
}
