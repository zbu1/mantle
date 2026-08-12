import { Component, ElementRef, computed, inject, viewChild } from '@angular/core';
import { LucideArrowLeft, LucideArrowRight, LucideChevronDown, LucideEllipsis, LucideExpand, LucideLock } from '@lucide/angular';
import { TabsState, NoteTab } from '../../../notes/tabs-state';
import { NotesState } from '../../../notes/notes-state';
import { NoteEditor } from '../../../notes/editor/note-editor';
import { ContextMenuState } from '../../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../../shared/context-menu/context-menu.model';

@Component({
  selector: 'app-content-area',
  imports: [
    NoteEditor,
    LucideArrowLeft,
    LucideArrowRight,
    LucideExpand,
    LucideEllipsis,
    LucideLock,
    LucideChevronDown,
  ],
  templateUrl: './content-area.html',
})
export class ContentArea {
  protected readonly tabsState = inject(TabsState);
  private readonly notesState = inject(NotesState);
  private readonly contextMenuState = inject(ContextMenuState);

  private readonly contentRoot = viewChild<ElementRef<HTMLElement>>('contentRoot');

  protected readonly activeTab = computed<NoteTab | undefined>(() => {
    const activeId = this.tabsState.activeId();
    return activeId ? this.tabsState.tabs().find((t) => t.id === activeId) : undefined;
  });

  protected goBack(): void {
    this.tabsState.goBack();
  }

  protected goForward(): void {
    this.tabsState.goForward();
  }

  protected notePath(tab: NoteTab): string {
    const segments = tab.noteId.split('/');
    segments.pop();
    return segments.length ? `${segments.join(' / ')} / ${tab.title}` : tab.title;
  }

  protected toggleFullscreen(): void {
    const el = this.contentRoot()?.nativeElement;
    if (!el) return;

    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen();
    }
  }

  protected onMoreClick(event: MouseEvent, tab: NoteTab): void {
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Copy Content', icon: 'copy', action: () => this.copyContent(tab.noteId) },
      { kind: 'item', label: 'Copy Title', icon: 'copy', action: () => navigator.clipboard.writeText(tab.title) },
    ];
    this.contextMenuState.open(event, items);
  }

  protected onContentContextMenu(event: MouseEvent): void {
    const tab = this.activeTab();
    if (!tab) return;

    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Copy Content', icon: 'copy', action: () => this.copyContent(tab.noteId) },
      { kind: 'item', label: 'Copy Title', icon: 'copy', action: () => navigator.clipboard.writeText(tab.title) },
      { kind: 'separator' },
      { kind: 'item', label: 'Close Tab', icon: 'close', action: () => this.tabsState.closeTab(tab.id) },
    ];
    this.contextMenuState.open(event, items);
  }

  private copyContent(noteId: string): void {
    const note = this.notesState.getNote(noteId);
    if (note) navigator.clipboard.writeText(note.content);
  }
}
