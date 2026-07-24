import { Component, ElementRef, computed, inject, viewChild } from '@angular/core';
import { LucideArrowLeft, LucideArrowRight, LucideChevronDown, LucideEllipsis, LucideExpand, LucideLock, LucideStar } from '@lucide/angular';
import { TabsState } from '../../../notes/tabs-state';
import { NotesState } from '../../../notes/notes-state';
import { Note } from '../../../notes/note.model';
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
    LucideStar,
  ],
  templateUrl: './content-area.html',
})
export class ContentArea {
  protected readonly tabsState = inject(TabsState);
  private readonly notesState = inject(NotesState);
  private readonly contextMenuState = inject(ContextMenuState);

  private readonly contentRoot = viewChild<ElementRef<HTMLElement>>('contentRoot');

  protected readonly activeNote = computed(() => {
    const activeId = this.tabsState.activeId();
    const tab = activeId ? this.tabsState.tabs().find((t) => t.id === activeId) : undefined;
    return tab ? this.notesState.getNote(tab.noteId) : undefined;
  });

  protected goBack(): void {
    this.tabsState.goBack();
  }

  protected goForward(): void {
    this.tabsState.goForward();
  }

  protected notePath(note: Note): string {
    return `${note.folder} / ${note.title}`;
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

  protected onMoreClick(event: MouseEvent, note: Note): void {
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Copy Content', icon: 'copy', action: () => navigator.clipboard.writeText(note.content) },
      { kind: 'item', label: 'Copy Title', icon: 'copy', action: () => navigator.clipboard.writeText(note.title) },
      { kind: 'separator' },
      { kind: 'item', label: 'Rename Note', icon: 'rename', action: () => {} },
      { kind: 'item', label: 'Duplicate Note', icon: 'duplicate', action: () => {} },
      { kind: 'separator' },
      { kind: 'item', label: 'Delete Note', icon: 'delete', danger: true, action: () => {} },
    ];
    this.contextMenuState.open(event, items);
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
