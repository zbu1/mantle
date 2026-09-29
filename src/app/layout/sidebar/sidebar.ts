import { Component, DestroyRef, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { LucideFileText, LucideLock } from '@lucide/angular';
import { SidebarSection } from './sidebar-section/sidebar-section';
import { SidebarItemButton } from './sidebar-item-button/sidebar-item-button';
import { VaultHeader } from './vault-header/vault-header';
import { VaultTreeNode } from './vault-tree-node/vault-tree-node';
import { CredentialsSection } from './credentials-section/credentials-section';
import { TagGroupRow } from './tag-group-row/tag-group-row';
import { CredentialsState } from '../../notes/credentials-state';
import { NewEncryptedNoteState } from '../../notes/new-encrypted-note/new-encrypted-note-state';
import { NoteEncryptionActions } from '../../notes/note-encryption-actions';
import { normalizeTag, TAG_RULES, TagGroup } from '../../notes/tags';
import { TagEditReport, TagsState } from '../../notes/tags-state';
import { COLLAPSE_THRESHOLD, SIDEBAR_SECTIONS, SidebarState } from './sidebar-state';
import { NotesState } from '../../notes/notes-state';
import { TabsState } from '../../notes/tabs-state';
import { VaultState } from '../../notes/vault-state';
import { VaultMetaState } from '../../notes/vault-meta-state';
import { formatRelativeTime } from '../../notes/relative-time';
import { VaultClipboardState } from '../../notes/vault-clipboard-state';
import { VaultDragState } from '../../notes/vault-drag-state';
import { VaultRenameState } from '../../notes/vault-rename-state';
import { VaultSelectionState } from '../../notes/vault-selection-state';
import {
  filterVaultTree,
  flattenAllNotes,
  flattenVaultNotes,
  isNoteLocked,
  isVaultTreeDrag,
  NOTE_REFERENCE_DRAG_MIME,
  VAULT_FOLDER_DRAG_MIME,
  VAULT_NOTE_DRAG_MIME,
  VaultFolderNode,
  VaultNoteNode,
} from '../../notes/vault-tree.model';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../shared/context-menu/context-menu.model';
import { DialogState } from '../../shared/dialog/dialog-state';

interface RecentRow {
  note: VaultNoteNode;
  openedAt: number;
  locked: boolean;
}

interface FavoriteRow {
  note: VaultNoteNode;
  locked: boolean;
  /** Parent folder shown next to the name, set only when another favorite shares the name. */
  folder: string | null;
}

@Component({
  selector: 'app-sidebar',
  imports: [SidebarSection, SidebarItemButton, VaultHeader, VaultTreeNode, CredentialsSection, TagGroupRow, LucideFileText, LucideLock],
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
  private readonly newEncryptedNoteState = inject(NewEncryptedNoteState);
  private readonly vaultMeta = inject(VaultMetaState);
  protected readonly tagsState = inject(TagsState);

  /** Text in the header's filter field; the tree shows only notes whose name contains it. Session-only. */
  protected readonly filterQuery = signal('');

  protected readonly visibleTree = computed(() => {
    const tree = this.vaultState.tree();
    return tree ? filterVaultTree(tree, this.filterQuery()) : null;
  });

  /** Whether any secondary section is shown, i.e. whether the stack below the tree renders at all. */
  protected readonly anySectionVisible = computed(() => SIDEBAR_SECTIONS.some(({ id }) => this.state.isSectionVisible(id)));

  /** Recent notes shown before the "Show more" expander is used. */
  private static readonly COLLAPSED_RECENT_COUNT = 5;

  /** Ticks once a minute so the relative "2h ago" labels stay current. */
  private readonly now = signal(Date.now());
  protected readonly showAllRecents = signal(false);

  /** Recent notes that still exist in the vault, most recently opened first. */
  private readonly recentRows = computed<RecentRow[]>(() => {
    const tree = this.vaultState.tree();
    if (!tree) return [];
    const notesByPath = new Map(flattenAllNotes(tree).map((note) => [note.relPath, note]));
    const unlocked = this.credentialsState.unlockedIds();
    return this.vaultMeta.recentNotes().flatMap((recent) => {
      const note = notesByPath.get(recent.relPath);
      return note ? [{ note, openedAt: recent.openedAt, locked: isNoteLocked(note, unlocked) }] : [];
    });
  });

  protected readonly visibleRecents = computed(() =>
    this.showAllRecents() ? this.recentRows() : this.recentRows().slice(0, Sidebar.COLLAPSED_RECENT_COUNT),
  );
  protected readonly hiddenRecentCount = computed(() => this.recentRows().length - this.visibleRecents().length);
  protected readonly canCollapseRecents = computed(
    () => this.showAllRecents() && this.recentRows().length > Sidebar.COLLAPSED_RECENT_COUNT,
  );

  /**
   * Favorites whose note is in the vault, in display order. A favorite whose
   * file is missing (e.g. removed outside the app) is hidden, not dropped.
   */
  protected readonly favoriteRows = computed<FavoriteRow[]>(() => {
    const tree = this.vaultState.tree();
    if (!tree) return [];
    const notesByPath = new Map(flattenAllNotes(tree).map((note) => [note.relPath, note]));
    const unlocked = this.credentialsState.unlockedIds();
    const notes = this.vaultMeta.favorites().flatMap((relPath) => notesByPath.get(relPath) ?? []);
    const nameCounts = new Map<string, number>();
    for (const note of notes) nameCounts.set(note.name, (nameCounts.get(note.name) ?? 0) + 1);
    return notes.map((note) => ({
      note,
      locked: isNoteLocked(note, unlocked),
      folder: nameCounts.get(note.name)! > 1 ? parentDirOf(note.relPath) || '/' : null,
    }));
  });

  /** Where a drag over Favorites would land: an index into `favoriteRows` (its length = the end), or null. */
  protected readonly favoriteDropIndex = signal<number | null>(null);

  private readonly dragStartX = signal<number | null>(null);
  private readonly dragStartWidth = signal<number>(0);

  constructor() {
    const refreshClock = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(refreshClock));

    // Revealing a tag (e.g. clicking its chip in the editor) needs its row on
    // screen, so open whatever hides it. The row itself scrolls and highlights.
    effect(() => {
      if (!this.tagsState.revealRequest()) return;
      untracked(() => {
        this.state.setCollapsed(false);
        if (!this.state.isSectionVisible('tags')) this.state.toggleSectionVisibility('tags');
        if (!this.state.isSectionExpanded('tags')) this.state.toggleSection('tags');
      });
    });

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

  protected recentTime(row: RecentRow): string {
    return formatRelativeTime(row.openedAt, this.now());
  }

  protected onRecentContextMenu(event: MouseEvent, row: RecentRow): void {
    const { note } = row;
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Open', icon: 'open', action: () => this.onOpenNote(note) },
      { kind: 'item', label: 'Open in New Tab', icon: 'open-new-tab', action: () => this.onOpenNoteInBackground(note) },
      { kind: 'separator' },
      { kind: 'item', label: 'Show in File Explorer', icon: 'reveal', action: () => void this.vaultState.revealInFileExplorer(note.relPath) },
      { kind: 'separator' },
      this.favoriteMenuItem(note.relPath),
      { kind: 'item', label: 'Remove from Recents', icon: 'close', action: () => this.vaultMeta.removeRecent(note.relPath) },
    ];
    this.contextMenuState.open(event, items);
  }

  protected onTagContextMenu(event: MouseEvent, group: TagGroup): void {
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Rename Tag…', icon: 'rename', action: () => void this.renameTag(group) },
      { kind: 'separator' },
      { kind: 'item', label: 'Remove Tag from All Notes', icon: 'delete', danger: true, action: () => void this.removeTag(group) },
    ];
    this.contextMenuState.open(event, items);
  }

  private async renameTag(group: TagGroup): Promise<void> {
    const to = await this.dialogState.prompt(
      `Rename #${group.name} in every note that has it. Renaming it to a tag that already exists merges the two.`,
      { title: 'Rename Tag', confirmLabel: 'Rename', initialValue: group.name, placeholder: 'tag' },
    );
    if (to === null || to.trim() === group.name) return;
    const normalized = normalizeTag(to);
    if (!normalized) {
      await this.dialogState.alert(`"${to.trim()}" isn't a valid tag. ${TAG_RULES}.`, { title: 'Rename Failed', tone: 'error' });
      return;
    }
    try {
      await this.reportLockedSkips(await this.tagsState.renameTag(group.name, normalized), 'renamed');
    } catch (err) {
      await this.dialogState.alert(err instanceof Error ? err.message : String(err), { title: 'Rename Failed', tone: 'error' });
    }
  }

  private async removeTag(group: TagGroup): Promise<void> {
    const count = group.notes.length;
    const confirmed = await this.dialogState.confirm(
      `Remove #${group.name} from ${count === 1 ? '1 note' : `${count} notes`}? The notes themselves are kept.`,
      { title: 'Remove Tag', tone: 'warning', confirmLabel: 'Remove Tag' },
    );
    if (!confirmed) return;
    try {
      await this.reportLockedSkips(await this.tagsState.removeTag(group.name), 'removed');
    } catch (err) {
      await this.dialogState.alert(err instanceof Error ? err.message : String(err), { title: 'Remove Failed', tone: 'error' });
    }
  }

  /** Locked notes can't be read, so a vault-wide tag edit can't reach them; say so rather than imply it did. */
  private async reportLockedSkips(report: TagEditReport, verb: string): Promise<void> {
    const skipped = report.lockedSkipped;
    if (skipped === 0) return;
    await this.dialogState.alert(
      `The tag was ${verb} in ${report.updated.length === 1 ? '1 note' : `${report.updated.length} notes`}, but ` +
        `${skipped === 1 ? '1 encrypted note is' : `${skipped} encrypted notes are`} in a locked profile and ` +
        `couldn't be checked. Unlock ${skipped === 1 ? 'its profile' : 'their profiles'} and do this again to include ${skipped === 1 ? 'it' : 'them'}.`,
      { title: 'Some Notes Were Skipped', tone: 'warning' },
    );
  }

  protected onOpenNote(note: VaultNoteNode): void {
    this.tabsState.openNote({ id: note.relPath, title: note.name });
  }

  protected onOpenNoteInBackground(note: VaultNoteNode): void {
    this.tabsState.openNoteInBackground({ id: note.relPath, title: note.name });
  }

  /**
   * A locked note was clicked: open it like any other note. The content area
   * shows a "this note is locked" screen with its own unlock affordance
   * rather than prompting for a password immediately.
   */
  protected onLockedClicked(note: VaultNoteNode): void {
    this.onOpenNote(note);
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
      const allFavorites = [...selected].every((relPath) => this.vaultMeta.isFavorite(relPath));
      items.push({
        kind: 'item',
        label: allFavorites ? `Remove ${selected.size} Notes from Favorites` : `Add ${selected.size} Notes to Favorites`,
        icon: allFavorites ? 'unfavorite' : 'favorite',
        action: () =>
          allFavorites ? this.vaultMeta.removeFavorites([...selected]) : this.vaultMeta.addFavorites([...selected]),
      });
      items.push({ kind: 'separator' });
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
      this.favoriteMenuItem(note.relPath),
      { kind: 'separator' },
      { kind: 'item', label: 'Delete', icon: 'delete', danger: true, action: () => void this.deleteNote(note) },
    ];
    this.contextMenuState.open(event, items);
  }

  protected onFolderContextMenu(payload: { event: MouseEvent; folder: VaultFolderNode }): void {
    const { event, folder } = payload;
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'New Note', icon: 'new-note', action: () => void this.onNewNote(folder.relPath) },
      {
        kind: 'item',
        label: 'New Encrypted Note',
        icon: 'new-encrypted-note',
        action: () => this.newEncryptedNoteState.open({ relDir: folder.relPath }),
      },
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

  /** Right-click on the vault tree's background: create/paste at the vault root. */
  protected onVaultContextMenu(event: MouseEvent): void {
    if (!this.vaultState.tree()) return;
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'New Note', icon: 'new-note', action: () => void this.onNewNote('') },
      {
        kind: 'item',
        label: 'New Encrypted Note',
        icon: 'new-encrypted-note',
        action: () => this.newEncryptedNoteState.open({ relDir: '' }),
      },
      { kind: 'item', label: 'New Folder', icon: 'new-folder', action: () => void this.onNewFolder('') },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Show in File Explorer',
        icon: 'reveal',
        action: () => void this.vaultState.revealInFileExplorer(''),
      },
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

  private favoriteMenuItem(relPath: string): ContextMenuItem {
    const favorite = this.vaultMeta.isFavorite(relPath);
    return {
      kind: 'item',
      label: favorite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: favorite ? 'unfavorite' : 'favorite',
      action: () => this.vaultMeta.toggleFavorite(relPath),
    };
  }

  protected onFavoriteContextMenu(event: MouseEvent, row: FavoriteRow): void {
    const { note } = row;
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Open', icon: 'open', action: () => this.onOpenNote(note) },
      { kind: 'item', label: 'Open in New Tab', icon: 'open-new-tab', action: () => this.onOpenNoteInBackground(note) },
      { kind: 'separator' },
      { kind: 'item', label: 'Show in File Explorer', icon: 'reveal', action: () => void this.vaultState.revealInFileExplorer(note.relPath) },
      { kind: 'separator' },
      { kind: 'item', label: 'Remove from Favorites', icon: 'unfavorite', action: () => this.vaultMeta.removeFavorites([note.relPath]) },
    ];
    this.contextMenuState.open(event, items);
  }

  /** Drags a Favorites or Recent Files row as a note reference — droppable on Favorites only. */
  protected onNoteReferenceDragStart(event: DragEvent, relPath: string): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(NOTE_REFERENCE_DRAG_MIME, relPath);
    event.dataTransfer.effectAllowed = 'move';
  }

  protected onFavoritesDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    if (!types.includes(NOTE_REFERENCE_DRAG_MIME) && !types.includes(VAULT_NOTE_DRAG_MIME)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dragState.clearHover();
    const row = (event.target as Element | null)?.closest<HTMLElement>('[data-favorite-index]');
    if (!row) {
      this.favoriteDropIndex.set(this.favoriteRows().length);
      return;
    }
    const rect = row.getBoundingClientRect();
    const index = Number(row.dataset['favoriteIndex']);
    this.favoriteDropIndex.set(event.clientY > rect.top + rect.height / 2 ? index + 1 : index);
  }

  protected onFavoritesDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    if (related && (event.currentTarget as HTMLElement).contains(related)) return;
    this.favoriteDropIndex.set(null);
  }

  protected onFavoritesDrop(event: DragEvent): void {
    event.preventDefault();
    const rows = this.favoriteRows();
    const index = this.favoriteDropIndex() ?? rows.length;
    this.favoriteDropIndex.set(null);
    const before = rows[index]?.note.relPath ?? null;
    const reference = event.dataTransfer?.getData(NOTE_REFERENCE_DRAG_MIME);
    if (reference) {
      this.vaultMeta.placeFavorites([reference], before);
      return;
    }
    const raw = event.dataTransfer?.getData(VAULT_NOTE_DRAG_MIME);
    if (!raw) return;
    try {
      this.vaultMeta.placeFavorites(JSON.parse(raw) as string[], before);
    } catch {
      // malformed drag payload — ignore
    }
  }

  /** Clears the drop indicator when a drag ends anywhere, e.g. cancelled with Esc over Favorites. */
  @HostListener('document:dragend')
  protected onDocumentDragEnd(): void {
    this.favoriteDropIndex.set(null);
  }

  protected onVaultBackgroundDragOver(event: DragEvent): void {
    if (!isVaultTreeDrag(event)) return;
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
      this.vaultMeta.renameNote(relPath, moved.relPath);
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
        this.vaultMeta.renameNote(oldNotePath, newNotePath);
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
      this.vaultMeta.renameNote(relPath, renamed.relPath);
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
        this.vaultMeta.renameNote(oldNotePath, newNotePath);
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
    this.vaultMeta.forgetNote(note.relPath);
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
      for (const relPath of affectedNotePaths) {
        this.tabsState.closeByNoteId(relPath);
        this.vaultMeta.forgetNote(relPath);
      }
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
      this.vaultMeta.forgetNote(relPath);
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
      this.vaultMeta.renameNote(clip.relPath, moved.relPath);
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

function parentDirOf(relPath: string): string {
  return relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
}
