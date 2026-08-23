import { Component, inject, input, output, signal } from '@angular/core';
import { LucideChevronRight, LucideFileText, LucideFolder, LucideLock } from '@lucide/angular';
import { VAULT_NOTE_DRAG_MIME, VaultFolderNode, VaultNode, VaultNoteNode } from '../../../notes/vault-tree.model';
import { VaultDragState } from '../../../notes/vault-drag-state';
import { VaultSelectionState } from '../../../notes/vault-selection-state';
import { SidebarItemButton } from '../sidebar-item-button/sidebar-item-button';

// Created once at module load (rather than per-dragstart) so it's already
// decoded by the time a drag begins — Chromium falls back to a generic
// dotted placeholder icon if setDragImage() is passed an image that isn't
// fully loaded yet. PNG rather than GIF: Chromium's drag-image renderer
// doesn't respect GIF transparency, which rendered as a stray white dot.
const EMPTY_DRAG_IMAGE = new Image();
EMPTY_DRAG_IMAGE.src =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

@Component({
  selector: 'app-vault-tree-node',
  imports: [SidebarItemButton, VaultTreeNode, LucideChevronRight, LucideFileText, LucideFolder, LucideLock],
  templateUrl: './vault-tree-node.html',
  host: { class: 'contents' },
})
export class VaultTreeNode {
  readonly node = input.required<VaultNode>();
  readonly depth = input(0);
  readonly openLockedHint = input<string | null>(null);

  readonly openNote = output<VaultNoteNode>();
  readonly openNoteInBackground = output<VaultNoteNode>();
  readonly noteContextMenu = output<{ event: MouseEvent; note: VaultNoteNode }>();
  readonly folderContextMenu = output<{ event: MouseEvent; folder: VaultFolderNode }>();
  readonly lockedClicked = output<string>();
  readonly notesDropped = output<{ relPaths: string[]; destRelDir: string }>();

  protected readonly selectionState = inject(VaultSelectionState);
  protected readonly dragState = inject(VaultDragState);

  protected readonly expanded = signal(true);

  protected asFolder(): VaultFolderNode | null {
    const n = this.node();
    return n.type === 'folder' ? n : null;
  }

  protected asNote(): VaultNoteNode | null {
    const n = this.node();
    return n.type === 'note' ? n : null;
  }

  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  protected onNoteClick(note: VaultNoteNode, event: MouseEvent): void {
    if (note.locked) {
      this.lockedClicked.emit(note.relPath);
      return;
    }
    if (event.shiftKey) {
      this.selectionState.selectRange(note.relPath, this.visibleNotePaths());
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      this.selectionState.toggle(note.relPath);
      return;
    }
    this.selectionState.selectOnly(note.relPath);
    this.openNote.emit(note);
  }

  protected onNoteContextMenu(note: VaultNoteNode, event: MouseEvent): void {
    if (!this.selectionState.isSelected(note.relPath)) {
      this.selectionState.selectOnly(note.relPath);
    }
    this.noteContextMenu.emit({ event, note });
  }

  private visibleNotePaths(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-vault-tree] [data-note-path]'))
      .map((el) => el.dataset['notePath'])
      .filter((path): path is string => !!path);
  }

  protected onNoteDragStart(note: VaultNoteNode, event: DragEvent): void {
    if (note.locked) {
      event.preventDefault();
      return;
    }
    if (!this.selectionState.isSelected(note.relPath)) {
      this.selectionState.selectOnly(note.relPath);
    }
    const selected = [...this.selectionState.selected()];
    event.dataTransfer?.setData(VAULT_NOTE_DRAG_MIME, JSON.stringify(selected));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Suppress the native drag ghost — VaultDragPreview renders the count/destination badge instead.
      event.dataTransfer.setDragImage(EMPTY_DRAG_IMAGE, 0, 0);
    }
    this.dragState.startDrag(selected.length);
  }

  protected onFolderDragOver(folder: VaultFolderNode, event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (this.isDraggingIntoOwnFolder(folder)) this.dragState.clearHover();
    else this.dragState.hover(folder.relPath, folder.name);
  }

  /** True if every currently-dragged note already lives directly in `folder`, making a drop there a no-op. */
  private isDraggingIntoOwnFolder(folder: VaultFolderNode): boolean {
    const selected = this.selectionState.selected();
    if (selected.size === 0) return false;
    for (const relPath of selected) {
      const parentDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
      if (parentDir !== folder.relPath) return false;
    }
    return true;
  }

  protected onFolderDrop(folder: VaultFolderNode, event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragState.clearHover();
    const raw = event.dataTransfer?.getData(VAULT_NOTE_DRAG_MIME);
    if (!raw) return;
    try {
      const relPaths = JSON.parse(raw) as string[];
      this.notesDropped.emit({ relPaths, destRelDir: folder.relPath });
    } catch {
      // malformed drag payload — ignore
    }
  }
}
