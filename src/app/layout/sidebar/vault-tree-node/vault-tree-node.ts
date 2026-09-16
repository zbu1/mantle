import { Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { LucideChevronRight, LucideFileText, LucideFolder, LucideLock, LucideLockOpen } from '@lucide/angular';
import {
  VAULT_FOLDER_DRAG_MIME,
  VAULT_NOTE_DRAG_MIME,
  VaultFolderNode,
  VaultNode,
  VaultNoteNode,
  isNoteLocked,
} from '../../../notes/vault-tree.model';
import { CredentialsState } from '../../../notes/credentials-state';
import { VaultDragState } from '../../../notes/vault-drag-state';
import { VaultRenameState } from '../../../notes/vault-rename-state';
import { VaultSelectionState } from '../../../notes/vault-selection-state';
import { SidebarItemButton } from '../sidebar-item-button/sidebar-item-button';
import { ExplorerRow } from '../explorer-row/explorer-row';
import { ExplorerBody } from '../explorer-body/explorer-body';

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
  imports: [
    SidebarItemButton,
    ExplorerRow,
    ExplorerBody,
    VaultTreeNode,
    LucideChevronRight,
    LucideFileText,
    LucideFolder,
    LucideLock,
    LucideLockOpen,
  ],
  templateUrl: './vault-tree-node.html',
  host: { class: 'contents' },
})
export class VaultTreeNode {
  readonly node = input.required<VaultNode>();
  readonly depth = input(0);
  /**
   * Ids of the credential profiles currently unlocked. Threaded down the
   * recursion rather than injected, keeping this component driven purely by
   * its inputs the way the rest of the tree is.
   */
  readonly unlockedProfiles = input<ReadonlySet<string>>(new Set<string>());

  readonly openNote = output<VaultNoteNode>();
  readonly openNoteInBackground = output<VaultNoteNode>();
  readonly noteContextMenu = output<{ event: MouseEvent; note: VaultNoteNode }>();
  readonly folderContextMenu = output<{ event: MouseEvent; folder: VaultFolderNode }>();
  /** A locked note was clicked; the sidebar prompts to unlock its profile. */
  readonly lockedClicked = output<VaultNoteNode>();
  readonly notesDropped = output<{ relPaths: string[]; destRelDir: string }>();
  readonly folderDropped = output<{ relPath: string; destRelDir: string }>();
  readonly noteRenamed = output<{ relPath: string; newName: string }>();
  readonly folderRenamed = output<{ relPath: string; newName: string }>();

  protected readonly selectionState = inject(VaultSelectionState);
  protected readonly dragState = inject(VaultDragState);
  protected readonly renameState = inject(VaultRenameState);
  protected readonly credentialsState = inject(CredentialsState);

  protected readonly expanded = signal(true);

  protected readonly renaming = computed(() => this.renameState.renamingPath() === this.node().relPath);

  private readonly renameInputRef = viewChild<ElementRef<HTMLInputElement>>('renameInput');

  constructor() {
    // Focus + select the rename input as soon as it's rendered.
    effect(() => {
      const el = this.renameInputRef()?.nativeElement;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }

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

  /** True when this note is encrypted *and* its profile isn't unlocked. */
  protected isLocked(note: VaultNoteNode): boolean {
    return isNoteLocked(note, this.unlockedProfiles());
  }

  protected profileName(note: VaultNoteNode): string {
    return this.credentialsState.displayNameOf(note.profile);
  }

  protected onNoteClick(note: VaultNoteNode, event: MouseEvent): void {
    if (this.isLocked(note)) {
      this.lockedClicked.emit(note);
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

  // Encrypted notes are draggable whether or not they're unlocked: moving a
  // note is a plain filesystem rename that never touches its contents.
  protected onNoteDragStart(note: VaultNoteNode, event: DragEvent): void {
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
    const draggedFolder = this.dragState.draggingFolder();
    if (draggedFolder) {
      if (this.isInvalidFolderDropTarget(draggedFolder.relPath, folder)) this.dragState.clearHover();
      else this.dragState.hover(folder.relPath, folder.name);
      return;
    }
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

  /** True if dropping `draggedRelPath` onto `target` would be a no-op or create a cycle (moving a folder into itself/a descendant). */
  private isInvalidFolderDropTarget(draggedRelPath: string, target: VaultFolderNode): boolean {
    if (target.relPath === draggedRelPath || target.relPath.startsWith(`${draggedRelPath}/`)) return true;
    const draggedParentDir = draggedRelPath.includes('/') ? draggedRelPath.slice(0, draggedRelPath.lastIndexOf('/')) : '';
    return draggedParentDir === target.relPath;
  }

  protected onRenameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.target as HTMLInputElement).blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.renameState.stop();
    }
  }

  protected onNoteRenameBlur(note: VaultNoteNode, value: string): void {
    if (this.renameState.renamingPath() !== note.relPath) return;
    this.renameState.stop();
    const newName = value.trim();
    if (!newName || newName === note.name) return;
    this.noteRenamed.emit({ relPath: note.relPath, newName });
  }

  protected onFolderRenameBlur(folder: VaultFolderNode, value: string): void {
    if (this.renameState.renamingPath() !== folder.relPath) return;
    this.renameState.stop();
    const newName = value.trim();
    if (!newName || newName === folder.name) return;
    this.folderRenamed.emit({ relPath: folder.relPath, newName });
  }

  protected onFolderDragStart(folder: VaultFolderNode, event: DragEvent): void {
    event.stopPropagation();
    event.dataTransfer?.setData(VAULT_FOLDER_DRAG_MIME, folder.relPath);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Suppress the native drag ghost — VaultDragPreview renders the folder name badge instead.
      event.dataTransfer.setDragImage(EMPTY_DRAG_IMAGE, 0, 0);
    }
    this.dragState.startFolderDrag(folder.relPath, folder.name);
  }

  protected onFolderDrop(folder: VaultFolderNode, event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragState.clearHover();
    const folderRelPath = event.dataTransfer?.getData(VAULT_FOLDER_DRAG_MIME);
    if (folderRelPath) {
      if (this.isInvalidFolderDropTarget(folderRelPath, folder)) return;
      this.folderDropped.emit({ relPath: folderRelPath, destRelDir: folder.relPath });
      return;
    }
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
