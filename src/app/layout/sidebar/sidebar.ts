import { Component, HostListener, effect, inject, signal } from '@angular/core';
import { LucideClock, LucideFileText, LucideFolders, LucideStar, LucideTags } from '@lucide/angular';
import { SidebarSection } from './sidebar-section/sidebar-section';
import { SidebarItemButton } from './sidebar-item-button/sidebar-item-button';
import { VaultTreeNode } from './vault-tree-node/vault-tree-node';
import { CredentialsSection } from './credentials-section/credentials-section';
import { TagGroupRow } from './tag-group-row/tag-group-row';
import { CredentialsState } from '../../notes/credentials-state';
import { NoteEncryptionActions } from '../../notes/note-encryption-actions';
import { FAVORITE_NOTES, MockNote, RECENT_NOTES, TAG_GROUPS } from '../../notes/notes-data';
import { COLLAPSE_THRESHOLD, SidebarState } from './sidebar-state';
import { NotesState } from '../../notes/notes-state';
import { TabsState } from '../../notes/tabs-state';
import { VaultState } from '../../notes/vault-state';
import { VaultClipboardState } from '../../notes/vault-clipboard-state';
import { VaultDragState } from '../../notes/vault-drag-state';
import { VaultRenameState } from '../../notes/vault-rename-state';
import { VaultSelectionState } from '../../notes/vault-selection-state';
import {
  flattenVaultNotes,
  VAULT_FOLDER_DRAG_MIME,
  VAULT_NOTE_DRAG_MIME,
  VaultFolderNode,
  VaultNoteNode,
} from '../../notes/vault-tree.model';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../shared/context-menu/context-menu.model';
import { DialogState } from '../../shared/dialog/dialog-state';

@Component({
  selector: 'app-sidebar',
  imports: [SidebarSection, SidebarItemButton, VaultTreeNode, CredentialsSection, TagGroupRow, LucideFolders, LucideStar, LucideClock, LucideTags, LucideFileText],
  templateUrl: './sidebar.html',
  host: { class: 'contents' },
})
export class Sidebar {
  protected readonly state = inject(SidebarState);
  protected readonly vaultState = inject(VaultState);
  private readonly tabsState = inject(TabsState);
  private readonly notesState = inject(NotesState);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly clipboardState = inject(VaultClipboardState);
  protected readonly selectionState = inject(VaultSelectionState);
  protected readonly dragState = inject(VaultDragState);
  private readonly renameState = inject(VaultRenameState);
  private readonly dialogState = inject(DialogState);
  protected readonly credentialsState = inject(CredentialsState);
  private readonly encryptionActions = inject(NoteEncryptionActions);

  protected readonly favorites = FAVORITE_NOTES;
  protected readonly recentFiles = RECENT_NOTES;
  protected readonly tagGroups = TAG_GROUPS;

  /** Session-only favorite toggle stub — not persisted, not wired to the real Favorites section yet. */
  protected readonly favoritedPaths = signal<ReadonlySet<string>>(new Set());

  private readonly dragStartX = signal<number | null>(null);
  private readonly dragStartWidth = signal<number>(0);

  constructor() {
    // Drop selected notes that no longer exist once the tree changes (deleted/moved externally).
    effect(() => {
      const tree = this.vaultState.tree();
      const validPaths = tree ? flattenVaultNotes(tree) : new Map<string, string>();
      for (const relPath of this.selectionState.selected()) {
        if (!validPaths.has(relPath)) this.selectionState.remove(relPath);
      }
    });
  }

  protected async onNewNote(relDir = ''): Promise<void> {
    const base = 'Untitled';
    for (let i = 0; i < 50; i++) {
      const name = i === 0 ? base : `${base} ${i + 1}`;
      try {
        const created = await this.vaultState.createNote(relDir, name);
        this.tabsState.openNote({ id: created.relPath, title: created.name });
        this.renameState.start(created.relPath);
        return;
      } catch {
        // name collision — try the next candidate
      }
    }
  }

  /** Creates a new folder in `relDir` (vault root by default); if notes are selected, moves them into it. */
  protected async onNewFolder(relDir = ''): Promise<void> {
    const base = 'New Folder';
    const selectedNotes = [...this.selectionState.selected()];
    for (let i = 0; i < 50; i++) {
      const name = i === 0 ? base : `${base} ${i + 1}`;
      try {
        const created = await this.vaultState.createFolder(relDir, name);
        if (selectedNotes.length > 0) {
          await this.onNotesDropped({ relPaths: selectedNotes, destRelDir: created.relPath });
        }
        this.renameState.start(created.relPath);
        return;
      } catch {
        // name collision — try the next candidate
      }
    }
  }

  protected openNote(note: MockNote): void {
    this.tabsState.openNote(note);
  }

  protected openNoteInBackground(note: MockNote): void {
    this.tabsState.openNoteInBackground(note);
  }

  protected openNoteContextMenu(event: MouseEvent, note: MockNote): void {
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

  protected onTagNoteContextMenu(payload: { event: MouseEvent; note: MockNote }): void {
    this.openNoteContextMenu(payload.event, payload.note);
  }

  protected onOpenNote(note: VaultNoteNode): void {
    this.tabsState.openNote({ id: note.relPath, title: note.name });
  }

  protected onOpenNoteInBackground(note: VaultNoteNode): void {
    this.tabsState.openNoteInBackground({ id: note.relPath, title: note.name });
  }

  /** A locked note was clicked: offer to unlock its profile, then open it. */
  protected async onLockedClicked(note: VaultNoteNode): Promise<void> {
    if (await this.credentialsState.promptUnlock(note.profile)) {
      this.onOpenNote(note);
    }
  }

  protected onNoteContextMenu(payload: { event: MouseEvent; note: VaultNoteNode }): void {
    const { event, note } = payload;
    const selected = this.selectionState.selected();
    if (selected.size > 1 && selected.has(note.relPath)) {
      const items: ContextMenuItem[] = [];
      if ([...selected].some((relPath) => relPath.includes('/'))) {
        items.push({
          kind: 'item',
          label: `Move ${selected.size} Notes to Root`,
          icon: 'move-to-root',
          action: () => void this.onNotesDropped({ relPaths: [...selected], destRelDir: '' }),
        });
        items.push({ kind: 'separator' });
      }
      items.push({
        kind: 'item',
        label: `Delete ${selected.size} Notes`,
        icon: 'delete',
        danger: true,
        action: () => void this.deleteSelectedNotes(),
      });
      this.contextMenuState.open(event, items);
      return;
    }
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Open', icon: 'open', action: () => this.onOpenNote(note) },
      { kind: 'item', label: 'Open in New Tab', icon: 'open-new-tab', action: () => this.onOpenNoteInBackground(note) },
      { kind: 'separator' },
      { kind: 'item', label: 'Show in File Explorer', icon: 'reveal', action: () => void this.vaultState.revealInFileExplorer(note.relPath) },
      { kind: 'separator' },
      { kind: 'item', label: 'Duplicate', icon: 'duplicate', action: () => void this.vaultState.duplicateNote(note.relPath) },
      { kind: 'item', label: 'Copy', icon: 'copy', action: () => this.clipboardState.copy(note) },
      { kind: 'item', label: 'Cut', icon: 'cut', action: () => this.clipboardState.cut(note) },
      ...(note.relPath.includes('/')
        ? [
            {
              kind: 'item' as const,
              label: 'Move to Root',
              icon: 'move-to-root' as const,
              action: () => void this.onNotesDropped({ relPaths: [note.relPath], destRelDir: '' }),
            },
          ]
        : []),
      { kind: 'separator' },
      ...this.encryptionActions.menuItems(note),
      { kind: 'separator' },
      { kind: 'item', label: 'Rename', icon: 'rename', action: () => this.renameState.start(note.relPath) },
      {
        kind: 'item',
        label: this.favoritedPaths().has(note.relPath) ? 'Remove from Favorites' : 'Add to Favorites',
        icon: this.favoritedPaths().has(note.relPath) ? 'unfavorite' : 'favorite',
        action: () => this.toggleFavoriteStub(note.relPath),
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Delete', icon: 'delete', danger: true, action: () => void this.deleteNote(note) },
    ];
    this.contextMenuState.open(event, items);
  }

  protected onFolderContextMenu(payload: { event: MouseEvent; folder: VaultFolderNode }): void {
    const { event, folder } = payload;
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'New Note', icon: 'new-note', action: () => void this.onNewNote(folder.relPath) },
      { kind: 'item', label: 'New Folder', icon: 'new-folder', action: () => void this.onNewFolder(folder.relPath) },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Show in File Explorer',
        icon: 'reveal',
        action: () => void this.vaultState.revealInFileExplorer(folder.relPath),
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Rename', icon: 'rename', action: () => this.renameState.start(folder.relPath) },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Paste',
        icon: 'paste',
        disabled: !this.clipboardState.entry(),
        action: () => void this.pasteInto(folder.relPath),
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Delete', icon: 'delete', danger: true, action: () => void this.deleteFolder(folder) },
    ];
    this.contextMenuState.open(event, items);
  }

  protected onVaultBackgroundContextMenu(event: MouseEvent): void {
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'New Note', icon: 'new-note', action: () => void this.onNewNote() },
      { kind: 'item', label: 'New Folder', icon: 'new-folder', action: () => void this.onNewFolder() },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Paste',
        icon: 'paste',
        disabled: !this.clipboardState.entry(),
        action: () => void this.pasteInto(''),
      },
    ];
    this.contextMenuState.open(event, items);
  }

  private toggleFavoriteStub(relPath: string): void {
    const next = new Set(this.favoritedPaths());
    if (next.has(relPath)) next.delete(relPath);
    else next.add(relPath);
    this.favoritedPaths.set(next);
  }

  protected onVaultBackgroundDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const draggedFolder = this.dragState.draggingFolder();
    if (draggedFolder) {
      if (!draggedFolder.relPath.includes('/')) this.dragState.clearHover();
      else this.dragState.hover('', 'Vault Root');
      return;
    }
    if (this.isDraggingIntoOwnRoot()) this.dragState.clearHover();
    else this.dragState.hover('', 'Vault Root');
  }

  protected onVaultBackgroundDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    const container = event.currentTarget as HTMLElement;
    if (related && container.contains(related)) return;
    this.dragState.clearHover();
  }

  /** True if every currently-dragged note already lives at the vault root, making a drop there a no-op. */
  private isDraggingIntoOwnRoot(): boolean {
    const selected = this.selectionState.selected();
    if (selected.size === 0) return false;
    for (const relPath of selected) {
      if (relPath.includes('/')) return false;
    }
    return true;
  }

  protected onVaultBackgroundDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragState.clearHover();
    const folderRelPath = event.dataTransfer?.getData(VAULT_FOLDER_DRAG_MIME);
    if (folderRelPath) {
      if (!folderRelPath.includes('/')) return;
      void this.onFolderDropped({ relPath: folderRelPath, destRelDir: '' });
      return;
    }
    const raw = event.dataTransfer?.getData(VAULT_NOTE_DRAG_MIME);
    if (!raw) return;
    try {
      const relPaths = JSON.parse(raw) as string[];
      void this.onNotesDropped({ relPaths, destRelDir: '' });
    } catch {
      // malformed drag payload — ignore
    }
  }

  /** Moves dropped notes into `destRelDir`, skipping any already there to avoid an accidental rename-collision. */
  protected async onNotesDropped(payload: { relPaths: string[]; destRelDir: string }): Promise<void> {
    const { relPaths, destRelDir } = payload;
    for (const relPath of relPaths) {
      const parentDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
      if (parentDir === destRelDir) continue;
      const moved = await this.vaultState.moveNote(relPath, destRelDir);
      this.notesState.renameNoteId(relPath, moved.relPath);
      this.tabsState.renameNoteId(relPath, moved.relPath, moved.name);
    }
    this.selectionState.clear();
  }

  /** Moves a dropped folder into `destRelDir` and retargets any open tabs for notes nested inside it. */
  protected async onFolderDropped(payload: { relPath: string; destRelDir: string }): Promise<void> {
    const { relPath, destRelDir } = payload;
    const parentDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    if (parentDir === destRelDir) return;
    const tree = this.vaultState.tree();
    const oldPrefix = `${relPath}/`;
    const affected = tree ? [...flattenVaultNotes(tree)].filter(([notePath]) => notePath.startsWith(oldPrefix)) : [];
    try {
      const moved = await this.vaultState.moveFolder(relPath, destRelDir);
      const newPrefix = `${moved.relPath}/`;
      for (const [oldNotePath, name] of affected) {
        const newNotePath = newPrefix + oldNotePath.slice(oldPrefix.length);
        this.notesState.renameNoteId(oldNotePath, newNotePath);
        this.tabsState.renameNoteId(oldNotePath, newNotePath, name);
      }
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Move Failed', tone: 'error' });
    }
  }

  protected async onNoteRenamed(payload: { relPath: string; newName: string }): Promise<void> {
    const { relPath, newName } = payload;
    try {
      const renamed = await this.vaultState.renameNote(relPath, newName);
      this.notesState.renameNoteId(relPath, renamed.relPath);
      this.tabsState.renameNoteId(relPath, renamed.relPath, renamed.name);
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Rename Failed', tone: 'error' });
    }
  }

  /** Renames a folder and retargets any open tabs for notes nested inside it. */
  protected async onFolderRenamed(payload: { relPath: string; newName: string }): Promise<void> {
    const { relPath, newName } = payload;
    const tree = this.vaultState.tree();
    const oldPrefix = `${relPath}/`;
    const affected = tree ? [...flattenVaultNotes(tree)].filter(([notePath]) => notePath.startsWith(oldPrefix)) : [];
    try {
      const renamed = await this.vaultState.renameFolder(relPath, newName);
      const newPrefix = `${renamed.relPath}/`;
      for (const [oldNotePath, name] of affected) {
        const newNotePath = newPrefix + oldNotePath.slice(oldPrefix.length);
        this.notesState.renameNoteId(oldNotePath, newNotePath);
        this.tabsState.renameNoteId(oldNotePath, newNotePath, name);
      }
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Rename Failed', tone: 'error' });
    }
  }

  private async deleteNote(note: VaultNoteNode): Promise<void> {
    const confirmed = await this.dialogState.confirm(`Move "${note.name}" to the system trash?`, {
      title: 'Delete Note',
      tone: 'warning',
      confirmLabel: 'Move to Trash',
    });
    if (!confirmed) return;
    await this.vaultState.deleteNote(note.relPath);
    this.tabsState.closeByNoteId(note.relPath);
  }

  private async deleteFolder(folder: VaultFolderNode): Promise<void> {
    const confirmed = await this.dialogState.confirm(
      `Move "${folder.name}" and everything inside it to the system trash?`,
      { title: 'Delete Folder', tone: 'warning', confirmLabel: 'Move to Trash' },
    );
    if (!confirmed) return;
    const affectedNotePaths = [...flattenVaultNotes(folder).keys()];
    try {
      await this.vaultState.deleteFolder(folder.relPath);
      for (const relPath of affectedNotePaths) this.tabsState.closeByNoteId(relPath);
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Delete Failed', tone: 'error' });
    }
  }

  private async deleteSelectedNotes(): Promise<void> {
    const relPaths = [...this.selectionState.selected()];
    const confirmed = await this.dialogState.confirm(`Move ${relPaths.length} notes to the system trash?`, {
      title: 'Delete Notes',
      tone: 'warning',
      confirmLabel: 'Move to Trash',
    });
    if (!confirmed) return;
    for (const relPath of relPaths) {
      await this.vaultState.deleteNote(relPath);
      this.tabsState.closeByNoteId(relPath);
    }
    this.selectionState.clear();
  }

  private async pasteInto(destRelDir: string): Promise<void> {
    const clip = this.clipboardState.entry();
    if (!clip) return;
    if (clip.mode === 'copy') {
      await this.vaultState.copyNote(clip.relPath, destRelDir);
    } else {
      const moved = await this.vaultState.moveNote(clip.relPath, destRelDir);
      this.notesState.renameNoteId(clip.relPath, moved.relPath);
      this.tabsState.renameNoteId(clip.relPath, moved.relPath, moved.name);
      this.clipboardState.clear();
    }
  }

  protected onResizePointerDown(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    this.dragStartX.set(event.clientX);
    // When collapsed the handle sits flush against the icon rail, i.e. at an
    // effective sidebar width of 0 — so drag distance maps directly to width.
    this.dragStartWidth.set(this.state.collapsed() ? 0 : this.state.width());
    this.state.resizing.set(true);
  }

  protected onResizePointerMove(event: PointerEvent): void {
    const startX = this.dragStartX();
    if (startX === null) return;
    const delta = event.clientX - startX;
    const prospective = this.dragStartWidth() + delta;
    if (prospective < COLLAPSE_THRESHOLD) {
      this.state.setCollapsed(true);
      return;
    }
    this.state.setCollapsed(false);
    this.state.setWidth(prospective);
  }

  protected onResizePointerUp(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    handle.releasePointerCapture(event.pointerId);
    this.endResize();
  }

  // Pointer capture is released implicitly (and this fires) if the capturing
  // element is removed from the DOM mid-drag, e.g. Angular tearing down other
  // parts of the sidebar in response to the collapse we just triggered —
  // without this, dragStartX/resizing could get stuck set.
  protected onResizeLostPointerCapture(): void {
    this.endResize();
  }

  // Shrinking the sidebar means dragging toward the window's own left edge,
  // so it's easy to release the mouse button outside the OS window — in that
  // case the handle never gets a pointerup or lostpointercapture, leaving the
  // drag stuck until reload. The window blurs whenever that happens (the
  // release hands focus to whatever is under the cursor), so use it as a
  // fallback to always end the drag.
  @HostListener('window:blur')
  protected onWindowBlur(): void {
    if (this.dragStartX() !== null) this.endResize();
  }

  private endResize(): void {
    this.dragStartX.set(null);
    this.state.resizing.set(false);
  }
}
