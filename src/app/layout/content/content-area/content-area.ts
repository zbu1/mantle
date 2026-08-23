import { Component, ElementRef, computed, inject, viewChild } from '@angular/core';
import { LucideArrowLeft, LucideArrowRight, LucideChevronDown, LucideEllipsis, LucideExpand, LucideLock } from '@lucide/angular';
import { TabsState, NoteTab } from '../../../notes/tabs-state';
import { NotesState, titleFromRelPath } from '../../../notes/notes-state';
import { VaultState } from '../../../notes/vault-state';
import { NoteEditor } from '../../../notes/editor/note-editor';
import { ContextMenuState } from '../../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../../shared/context-menu/context-menu.model';
import { DialogState } from '../../../shared/dialog/dialog-state';

const RENAME_DEBOUNCE_MS = 1000;

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
  private readonly vaultState = inject(VaultState);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly dialogState = inject(DialogState);

  private readonly contentRoot = viewChild<ElementRef<HTMLElement>>('contentRoot');
  private readonly pendingRenames = new Map<string, ReturnType<typeof setTimeout>>();

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

  /** Reflects each keystroke into the tab title and sidebar entry right away; the on-disk rename is debounced. */
  protected onTitleInput(tab: NoteTab, value: string): void {
    this.tabsState.updateTabTitle(tab.id, value);
    this.vaultState.renameNoteInTree(tab.noteId, tab.noteId, value);
    this.scheduleRename(tab.id);
  }

  protected onTitleKeydown(event: KeyboardEvent, tab: NoteTab, input: HTMLInputElement): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelPendingRename(tab.id);
      const onDiskTitle = titleFromRelPath(tab.noteId);
      input.value = onDiskTitle;
      this.tabsState.updateTabTitle(tab.id, onDiskTitle);
      this.vaultState.renameNoteInTree(tab.noteId, tab.noteId, onDiskTitle);
      input.blur();
    }
  }

  protected onTitleBlur(tab: NoteTab): void {
    this.cancelPendingRename(tab.id);
    void this.commitRename(tab.id);
  }

  private scheduleRename(tabId: string): void {
    this.cancelPendingRename(tabId);
    this.pendingRenames.set(
      tabId,
      setTimeout(() => {
        this.pendingRenames.delete(tabId);
        void this.commitRename(tabId);
      }, RENAME_DEBOUNCE_MS),
    );
  }

  private cancelPendingRename(tabId: string): void {
    const existing = this.pendingRenames.get(tabId);
    if (existing) {
      clearTimeout(existing);
      this.pendingRenames.delete(tabId);
    }
  }

  private async commitRename(tabId: string): Promise<void> {
    const tab = this.tabsState.tabs().find((t) => t.id === tabId);
    if (!tab) return;

    const onDiskTitle = titleFromRelPath(tab.noteId);
    const newTitle = tab.title.trim();
    if (!newTitle || newTitle === onDiskTitle) {
      this.tabsState.updateTabTitle(tabId, newTitle || onDiskTitle);
      return;
    }

    try {
      const renamed = await this.vaultState.renameNote(tab.noteId, newTitle);
      this.notesState.renameNoteId(tab.noteId, renamed.relPath);
      this.tabsState.renameNoteId(tab.noteId, renamed.relPath, renamed.name);
      this.vaultState.renameNoteInTree(tab.noteId, renamed.relPath, renamed.name);
    } catch (err) {
      this.tabsState.updateTabTitle(tabId, onDiskTitle);
      this.vaultState.renameNoteInTree(tab.noteId, tab.noteId, onDiskTitle);
      await this.dialogState.alert(String(err), { title: 'Rename Failed', tone: 'error' });
    }
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
