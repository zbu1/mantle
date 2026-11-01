import { isMobile } from '../../../core/tauri-env';
import { DialogState } from '../../../shared/dialog/dialog-state';
import { Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { LucideChevronRight, LucideLock, LucideLockOpen } from '@lucide/angular';
import {
  VAULT_FOLDER_DRAG_MIME,
  VAULT_NOTE_DRAG_MIME,
  VaultFileNode,
  VaultFolderNode,
  VaultNode,
  VaultNoteNode,
  dirOf,
  isNoteLocked,
  isVaultTreeDrag,
  markdownExtensionOf,
} from '../../../notes/vault-tree.model';
import { CredentialsState } from '../../../notes/credentials-state';
import { TabsState } from '../../../notes/tabs-state';
import { VaultMetaState } from '../../../notes/vault-meta-state';
import { VaultDragState } from '../../../notes/vault-drag-state';
import { VaultRenameState } from '../../../notes/vault-rename-state';
import { VaultSelectionState } from '../../../notes/vault-selection-state';
import { SidebarItemButton } from '../sidebar-item-button/sidebar-item-button';
import { ExplorerRow } from '../explorer-row/explorer-row';
import { ExplorerBody } from '../explorer-body/explorer-body';
import { ItemStyleIcon } from '../../../shared/item-style/item-style';
import { ItemStyleState } from '../../../notes/item-style-state';
import { HoverTooltip } from '../../../shared/hover-tooltip/hover-tooltip';
import { SidebarState } from '../sidebar-state';

/** How long a revealed folder stays highlighted. */
const REVEAL_FLASH_MS = 1400;

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
    HoverTooltip,
    ItemStyleIcon,
    LucideChevronRight,
    LucideLock,
    LucideLockOpen,
  ],
  templateUrl: './vault-tree-node.html',
  host: { class: 'contents' },
})
export class VaultTreeNode {
  protected readonly itemStyles = inject(ItemStyleState);
  readonly node = input.required<VaultNode>();
  readonly depth = input(0);
  /**
   * Ids of the credential profiles currently unlocked. Threaded down the
   * recursion rather than injected, keeping this component driven purely by
   * its inputs the way the rest of the tree is.
   */
  readonly unlockedProfiles = input<ReadonlySet<string>>(new Set<string>());
  /**
   * The sidebar's filter text. The tree is already pruned to matches; this
   * marks the match in each name and holds every folder open.
   */
  readonly filter = input('');

  readonly openNote = output<VaultNoteNode>();
  readonly openNoteInBackground = output<VaultNoteNode>();
  readonly noteContextMenu = output<{ event: MouseEvent; note: VaultNoteNode }>();
  readonly folderContextMenu = output<{ event: MouseEvent; folder: VaultFolderNode }>();
  /**
   * A locked note was clicked. The sidebar opens it like any other note; the
   * content area shows a "this note is locked" screen rather than prompting
   * for a password immediately.
   */
  readonly lockedClicked = output<VaultNoteNode>();
  readonly notesDropped = output<{ relPaths: string[]; destRelDir: string }>();
  readonly folderDropped = output<{ relPath: string; destRelDir: string }>();
  readonly noteRenamed = output<{ relPath: string; newName: string }>();
  readonly folderRenamed = output<{ relPath: string; newName: string }>();
  readonly openFile = output<VaultFileNode>();
  readonly fileContextMenu = output<{ event: MouseEvent; file: VaultFileNode }>();

  protected readonly selectionState = inject(VaultSelectionState);
  protected readonly dragState = inject(VaultDragState);
  protected readonly renameState = inject(VaultRenameState);
  protected readonly credentialsState = inject(CredentialsState);
  private readonly tabsState = inject(TabsState);
  private readonly dialogState = inject(DialogState);
  private readonly sidebarState = inject(SidebarState);
  private readonly vaultMeta = inject(VaultMetaState);

  /** Left padding of a folder row at depth 0, and per level. Tighter than the secondary sections: the tree is the body. */
  protected readonly BASE_INDENT = 8;
  protected readonly INDENT_STEP = 14;

  /** Folders are held open while filtering, so every match is in view. */
  protected readonly isExpanded = computed(
    () => !this.vaultMeta.collapsedFolders().has(this.node().relPath) || this.filter().trim() !== '',
  );

  /** The note open in the active tab, which gets the ember rail. */
  protected readonly activeNoteId = computed(() => {
    const activeId = this.tabsState.activeId();
    return this.tabsState.tabs().find((tab) => tab.id === activeId)?.noteId ?? null;
  });

  private readonly renameRequested = computed(() => this.renameState.renamingPath() === this.node().relPath);
  /** Inline rename on desktop; Android asks in a bottom-sheet prompt instead. */
  protected readonly renaming = computed(() => this.renameRequested() && !isMobile);

  private readonly renameInputRef = viewChild<ElementRef<HTMLInputElement>>('renameInput');

  /** Briefly true after the folder is revealed, e.g. from the editor's breadcrumb. */
  protected readonly flashing = signal(false);
  private readonly folderRow = viewChild<ElementRef<HTMLElement>>('folderRow');

  constructor() {
    effect(() => {
      if (isMobile && this.renameRequested()) untracked(() => void this.promptRename());
    });

    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    inject(DestroyRef).onDestroy(() => clearTimeout(flashTimer));

    // Ancestors of the revealed folder open up; the folder itself consumes the
    // request, opens, scrolls into view and flashes.
    effect(() => {
      const request = this.sidebarState.folderRevealRequest();
      const folder = this.asFolder();
      if (!request || !folder) return;
      if (request.relPath.startsWith(folder.relPath + '/')) {
        untracked(() => this.vaultMeta.setFolderCollapsed(folder.relPath, false));
      } else if (request.relPath === folder.relPath) {
        untracked(() => {
          this.sidebarState.folderRevealRequest.set(null);
          this.vaultMeta.setFolderCollapsed(folder.relPath, false);
          this.flashing.set(true);
          clearTimeout(flashTimer);
          flashTimer = setTimeout(() => this.flashing.set(false), REVEAL_FLASH_MS);
          setTimeout(() => this.folderRow()?.nativeElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
        });
      }
    });

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

  protected asFile(): VaultFileNode | null {
    const n = this.node();
    return n.type === 'file' ? n : null;
  }

  /** A file's name and its extension, shown muted like a Markdown note's. */
  protected fileLabel(file: VaultFileNode): { name: string; ext: string | null } {
    const dot = file.name.lastIndexOf('.');
    return dot > 0 ? { name: file.name.slice(0, dot), ext: file.name.slice(dot) } : { name: file.name, ext: null };
  }

  protected indentOf(depth: number): number {
    return this.BASE_INDENT + depth * this.INDENT_STEP;
  }

  /** A note's name lines up with its sibling folders' names: past the chevron (12px) and its gap (6px). */
  protected noteIndentOf(depth: number): number {
    return this.indentOf(depth) + 18;
  }

  protected toggleExpanded(): void {
    this.vaultMeta.setFolderCollapsed(this.node().relPath, this.isExpanded());
  }

  /** A plain click still opens/closes the folder; ctrl/cmd- and shift-clicks select it. */
  protected onFolderToggle(folder: VaultFolderNode, event: Event): void {
    if (!(event instanceof MouseEvent && this.selectWithModifiers(folder.relPath, event))) this.toggleExpanded();
  }

  protected onFileClick(file: VaultFileNode, event: MouseEvent): void {
    if (this.selectWithModifiers(file.relPath, event)) return;
    this.selectionState.selectOnly(file.relPath);
    this.openFile.emit(file);
  }

  /** Shift-click selects a range, ctrl/cmd-click toggles one item. False for a plain click. */
  private selectWithModifiers(relPath: string, event: MouseEvent): boolean {
    if (event.shiftKey) this.selectionState.selectRange(relPath, this.visibleTreePaths());
    else if (event.ctrlKey || event.metaKey) this.selectionState.toggle(relPath);
    else return false;
    return true;
  }

  /** True when this note is encrypted *and* its profile isn't unlocked. */
  protected isLocked(note: VaultNoteNode): boolean {
    return isNoteLocked(note, this.unlockedProfiles());
  }

  protected profileName(note: VaultNoteNode): string {
    return this.credentialsState.displayNameOf(note.profile);
  }

  /** The `.md` / `.markdown` shown after a plain Markdown file's name, if extensions are on; never for a Mantle note. */
  protected markdownExt(note: VaultNoteNode): string | null {
    return this.sidebarState.showExtensions() ? markdownExtensionOf(note.relPath) : null;
  }

  /** Sublabel for the note's hover tooltip: encryption state, and profile name if encrypted. */
  protected encryptionStatus(note: VaultNoteNode): string {
    if (!note.encrypted) return markdownExtensionOf(note.relPath) ? 'Plain Markdown file' : 'Not encrypted';
    return `${this.isLocked(note) ? 'Locked' : 'Unlocked'} · ${this.profileName(note)}`;
  }

  protected onNoteClick(note: VaultNoteNode, event: MouseEvent): void {
    if (this.isLocked(note)) {
      this.lockedClicked.emit(note);
      return;
    }
    if (this.selectWithModifiers(note.relPath, event)) return;
    this.selectionState.selectOnly(note.relPath);
    this.openNote.emit(note);
  }

  protected onNoteContextMenu(note: VaultNoteNode, event: MouseEvent): void {
    if (!this.selectionState.isSelected(note.relPath)) {
      this.selectionState.selectOnly(note.relPath);
    }
    this.noteContextMenu.emit({ event, note });
  }

  private visibleTreePaths(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-vault-tree] [data-tree-path]'))
      .map((el) => el.dataset['treePath'])
      .filter((path): path is string => !!path);
  }

  // Encrypted notes are draggable whether or not they're unlocked: moving a
  // note is a plain filesystem rename that never touches its contents.
  // Dragging any selected item (note, folder or file) drags the whole selection.
  protected onItemDragStart(relPath: string, event: DragEvent): void {
    event.stopPropagation();
    if (!this.selectionState.isSelected(relPath)) {
      this.selectionState.selectOnly(relPath);
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
    if (!isVaultTreeDrag(event)) return;
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

  /**
   * True if a drop of the dragged selection on `folder` would do nothing: every
   * item already lives directly in it, or it is (inside) a dragged folder.
   */
  private isDraggingIntoOwnFolder(folder: VaultFolderNode): boolean {
    const selected = this.selectionState.selected();
    if (selected.size === 0) return false;
    for (const relPath of selected) {
      if (folder.relPath === relPath || folder.relPath.startsWith(`${relPath}/`)) return true;
    }
    for (const relPath of selected) {
      if (dirOf(relPath) !== folder.relPath) return false;
    }
    return true;
  }

  /** True if dropping `draggedRelPath` onto `target` would be a no-op or create a cycle (moving a folder into itself/a descendant). */
  private isInvalidFolderDropTarget(draggedRelPath: string, target: VaultFolderNode): boolean {
    if (target.relPath === draggedRelPath || target.relPath.startsWith(`${draggedRelPath}/`)) return true;
    return dirOf(draggedRelPath) === target.relPath;
  }

  private async promptRename(): Promise<void> {
    const item = this.asNote() ?? this.asFolder();
    if (!item) return;
    const value = await this.dialogState.prompt('', { title: 'Rename', initialValue: item.name, confirmLabel: 'OK' });
    if (this.renameState.renamingPath() !== item.relPath) return;
    this.renameState.renamingPath.set(null);
    const newName = value?.trim();
    if (!newName || newName === item.name) return;
    const payload = { relPath: item.relPath, newName };
    if (this.asNote()) this.noteRenamed.emit(payload);
    else this.folderRenamed.emit(payload);
  }

  protected onRenameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.target as HTMLInputElement).blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.renameState.renamingPath.set(null);
    }
  }

  protected onNoteRenameBlur(note: VaultNoteNode, value: string): void {
    if (this.renameState.renamingPath() !== note.relPath) return;
    this.renameState.renamingPath.set(null);
    const newName = value.trim();
    if (!newName || newName === note.name) return;
    this.noteRenamed.emit({ relPath: note.relPath, newName });
  }

  protected onFolderRenameBlur(folder: VaultFolderNode, value: string): void {
    if (this.renameState.renamingPath() !== folder.relPath) return;
    this.renameState.renamingPath.set(null);
    const newName = value.trim();
    if (!newName || newName === folder.name) return;
    this.folderRenamed.emit({ relPath: folder.relPath, newName });
  }

  protected onFolderDragStart(folder: VaultFolderNode, event: DragEvent): void {
    if (this.selectionState.isSelected(folder.relPath) && this.selectionState.selected().size > 1) {
      this.onItemDragStart(folder.relPath, event);
      return;
    }
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
