import { Component, DestroyRef, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { LucideFileText, LucideLock } from '@lucide/angular';
import { SidebarSection } from './sidebar-section/sidebar-section';
import { SidebarItemButton } from './sidebar-item-button/sidebar-item-button';
import { VaultHeader } from './vault-header/vault-header';
import { VaultTreeNode } from './vault-tree-node/vault-tree-node';
import { CredentialsSection } from './credentials-section/credentials-section';
import { TagGroupRow } from './tag-group-row/tag-group-row';
import { AttachmentsState } from '../../notes/attachments-state';
import { CredentialsState } from '../../notes/credentials-state';
import { NewEncryptedNoteState } from '../../notes/new-encrypted-note/new-encrypted-note-state';
import { MarkdownExportState } from '../../notes/markdown-export/markdown-export-state';
import { NoteEncryptionActions } from '../../notes/note-encryption-actions';
import { TagGroup } from '../../notes/tags';
import { VaultActions } from '../../notes/vault-actions';
import { canUndoDelete } from '../../notes/vault-history-state';
import { focusNoteTitle } from '../../notes/tab-menu';
import { TagActions } from '../../notes/tag-actions';
import { TagsState } from '../../notes/tags-state';
import { COLLAPSE_THRESHOLD, SIDEBAR_SECTIONS, SidebarState } from './sidebar-state';
import { TabsState } from '../../notes/tabs-state';
import { VaultState } from '../../notes/vault-state';
import { FavoritesState } from '../../notes/favorites-state';
import { VaultMetaState } from '../../notes/vault-meta-state';
import { formatRelativeTime } from '../../notes/relative-time';
import { VaultClipboardState } from '../../notes/vault-clipboard-state';
import { VaultDragState } from '../../notes/vault-drag-state';
import { VaultRenameState } from '../../notes/vault-rename-state';
import { VaultSelectionState } from '../../notes/vault-selection-state';
import {
  filterVaultTree,
  findFolder,
  sortVaultTree,
  flattenAllNotes,
  flattenTreeNodes,
  topmostPaths,
  dirOf,
  flattenVaultNotes,
  isNoteLocked,
  isVaultTreeDrag,
  markdownExtensionOf,
  NOTE_REFERENCE_DRAG_MIME,
  VAULT_FOLDER_DRAG_MIME,
  VAULT_NOTE_DRAG_MIME,
  VaultFileNode,
  VaultFolderNode,
  VaultNode,
  VaultNoteNode,
} from '../../notes/vault-tree.model';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../shared/context-menu/context-menu.model';
import { DialogState } from '../../shared/dialog/dialog-state';
import { EditContextState, TreeEditCommand } from '../../shared/edit-context-state';

interface RecentRow {
  note: VaultNoteNode;
  openedAt: number;
  locked: boolean;
}

interface FavoriteRow {
  note: VaultNoteNode;
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
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly clipboardState = inject(VaultClipboardState);
  protected readonly selectionState = inject(VaultSelectionState);
  protected readonly dragState = inject(VaultDragState);
  private readonly renameState = inject(VaultRenameState);
  private readonly dialogState = inject(DialogState);
  protected readonly credentialsState = inject(CredentialsState);
  private readonly encryptionActions = inject(NoteEncryptionActions);
  private readonly markdownExport = inject(MarkdownExportState);
  private readonly newEncryptedNoteState = inject(NewEncryptedNoteState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly favorites = inject(FavoritesState);
  protected readonly tagsState = inject(TagsState);
  private readonly attachments = inject(AttachmentsState);
  private readonly editContext = inject(EditContextState);
  private readonly tagActions = inject(TagActions);
  private readonly vaultActions = inject(VaultActions);

  /** Text in the header's filter field; the tree shows only notes whose name contains it. Session-only. */
  protected readonly filterQuery = signal('');

  protected readonly visibleTree = computed(() => {
    const tree = this.vaultState.tree();
    return tree ? sortVaultTree(filterVaultTree(tree, this.filterQuery()), this.vaultMeta.sortMode(), this.vaultMeta.order()) : null;
  });

  /** Every tree node by relPath, for telling what kind of item a selected path is. */
  private readonly nodesByPath = computed(() => {
    const tree = this.vaultState.tree();
    return tree ? flattenTreeNodes(tree) : new Map<string, VaultNode>();
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

  /** Favorites in display order — see `FavoritesState.notes`. */
  protected readonly favoriteRows = computed<FavoriteRow[]>(() => {
    const notes = this.favorites.notes();
    const nameCounts = new Map<string, number>();
    for (const note of notes) nameCounts.set(note.name, (nameCounts.get(note.name) ?? 0) + 1);
    return notes.map((note) => ({
      note,
      folder: nameCounts.get(note.name)! > 1 ? dirOf(note.relPath) || '/' : null,
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

    this.editContext.registerTree({
      can: (command) => this.canRunTreeCommand(command),
      run: (command) => this.runTreeCommand(command),
    });

    // Drop selected items that no longer exist once the tree changes (deleted/moved externally).
    effect(() => {
      const validPaths = this.nodesByPath();
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
        const created = await this.vaultActions.createNote(relDir, name);
        this.tabsState.openNote({ id: created.relPath, title: created.name });
        focusNoteTitle();
        return;
      } catch {
        // name collision — try the next candidate
      }
    }
  }

  /** Creates a new folder in `relDir` (vault root by default); if items are selected, moves them into it. */
  protected async onNewFolder(relDir = ''): Promise<void> {
    const base = 'New Folder';
    const selectedNotes = [...this.selectionState.selected()];
    for (let i = 0; i < 50; i++) {
      const name = i === 0 ? base : `${base} ${i + 1}`;
      try {
        const created = await this.vaultActions.createFolder(relDir, name);
        if (selectedNotes.length > 0) {
          await this.onNotesDropped({ relPaths: selectedNotes, destRelDir: created.relPath });
        }
        this.renameState.renamingPath.set(created.relPath);
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
      { kind: 'item', label: 'Rename Tag…', icon: 'rename', action: () => void this.tagActions.rename(group.name) },
      { kind: 'separator' },
      { kind: 'item', label: 'Remove Tag from All Notes', icon: 'delete', danger: true, action: () => void this.tagActions.remove(group.name, group.notes.length) },
    ];
    this.contextMenuState.open(event, items);
  }

  protected onOpenNote(note: VaultNoteNode): void {
    this.tabsState.openNote({ id: note.relPath, title: note.name });
  }

  protected onOpenNoteInBackground(note: VaultNoteNode): void {
    this.tabsState.openNoteInBackground({ id: note.relPath, title: note.name });
  }

  /** Files open in a read-only preview tab, which tabs tell apart from notes by extension. */
  protected onOpenFile(file: VaultFileNode): void {
    this.tabsState.openNote({ id: file.relPath, title: file.name });
  }

  protected onFileContextMenu(payload: { event: MouseEvent; file: VaultFileNode }): void {
    const { event, file } = payload;
    if (this.openSelectionMenu(event, file.relPath)) return;
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Open', icon: 'open', action: () => this.onOpenFile(file) },
      {
        kind: 'item',
        label: 'Open in New Tab',
        icon: 'open-new-tab',
        action: () => this.tabsState.openNoteInBackground({ id: file.relPath, title: file.name }),
      },
      {
        kind: 'item',
        label: 'Open in Default App',
        icon: 'open-external',
        action: () => void this.attachments.openInDefaultApp(file.relPath),
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Show in File Explorer', icon: 'reveal', action: () => void this.vaultState.revealInFileExplorer(file.relPath) },
      { kind: 'item', label: 'Copy Path', icon: 'copy', action: () => void navigator.clipboard.writeText(file.relPath) },
      { kind: 'separator' },
      { kind: 'item', label: 'Delete', icon: 'delete', danger: true, action: () => void this.deleteFile(file) },
    ];
    this.contextMenuState.open(event, items);
  }

  private async deleteFile(file: VaultFileNode): Promise<void> {
    const confirmed =
      canUndoDelete ||
      (await this.dialogState.confirm(`Move "${file.name}" to the system trash? Notes that show it will show a broken image.`, {
        title: 'Delete File',
        tone: 'warning',
        confirmLabel: 'Move to Trash',
      }));
    if (!confirmed) return;
    try {
      await this.vaultActions.delete([file]);
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Delete Failed', tone: 'error' });
    }
  }

  /**
   * A locked note was clicked: open it like any other note. The content area
   * shows a "this note is locked" screen with its own unlock affordance
   * rather than prompting for a password immediately.
   */
  /**
   * One row per locked profile with hidden notes, which the tree leaves out,
   * plus one for hidden notes whose profile isn't in this vault. Clicking a
   * row opens its profile's unlock prompt.
   */
  protected readonly hiddenRows = computed(() => {
    type Row = { profileId: string; label: string; count: number };
    const rows: Row[] = [];
    const unknown: Row = { profileId: '', label: 'unknown profile', count: 0 };
    for (const [profileId, count] of Object.entries(this.vaultState.lockedHidden())) {
      const profile = this.credentialsState.profileById(profileId);
      if (profile) rows.push({ profileId, label: profile.displayName, count });
      else Object.assign(unknown, { profileId, count: unknown.count + count });
    }
    return unknown.count > 0 ? [...rows, unknown] : rows;
  });

  protected onHiddenRowClicked(profileId: string): void {
    void this.credentialsState.promptUnlock(profileId);
  }

  protected onLockedClicked(note: VaultNoteNode): void {
    this.onOpenNote(note);
  }

  protected onNoteContextMenu(payload: { event: MouseEvent; note: VaultNoteNode }): void {
    const { event, note } = payload;
    if (this.openSelectionMenu(event, note.relPath)) return;
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Open', icon: 'open', action: () => this.onOpenNote(note) },
      { kind: 'item', label: 'Open in New Tab', icon: 'open-new-tab', action: () => this.onOpenNoteInBackground(note) },
      {
        kind: 'item',
        label: 'Open to the Right',
        action: () => this.tabsState.openBeside({ id: note.relPath, title: note.name }),
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Show in File Explorer', icon: 'reveal', action: () => void this.vaultState.revealInFileExplorer(note.relPath) },
      { kind: 'separator' },
      { kind: 'item', label: 'Duplicate', icon: 'duplicate', action: () => void this.vaultActions.duplicate(note.relPath) },
      { kind: 'item', label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: () => this.clipboardState.copy([note.relPath]) },
      { kind: 'item', label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', action: () => this.clipboardState.cut([note.relPath]) },
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
      ...(markdownExtensionOf(note.relPath) || (note.encrypted && !this.credentialsState.isUnlocked(note.profile))
        ? []
        : [
            {
              kind: 'item' as const,
              label: 'Convert to Markdown…',
              icon: 'convert' as const,
              action: () => this.markdownExport.openConvert([note]),
            },
          ]),
      { kind: 'separator' },
      { kind: 'item', label: 'Rename', icon: 'rename', action: () => this.renameState.renamingPath.set(note.relPath) },
      this.favoriteMenuItem(note.relPath),
      // Planned: per-note icon and color.
      { kind: 'item', label: 'Set Icon…', disabled: true, action: () => undefined },
      { kind: 'item', label: 'Set Color…', disabled: true, action: () => undefined },
      { kind: 'separator' },
      { kind: 'item', label: 'Delete', icon: 'delete', danger: true, action: () => void this.deleteNote(note) },
    ];
    this.contextMenuState.open(event, items);
  }

  /**
   * The menu for a right-click on an item that's part of a multi-selection —
   * notes, folders and files alike. Returns false (opening nothing) otherwise.
   */
  private openSelectionMenu(event: MouseEvent, relPath: string): boolean {
    const selected = [...this.selectionState.selected()];
    if (selected.length < 2 || !selected.includes(relPath)) return false;
    const nodes = this.nodesByPath();
    const allNotes = selected.every((path) => nodes.get(path)?.type === 'note');
    const what = `${selected.length} ${allNotes ? 'Notes' : 'Items'}`;
    // Folders don't open in a tab; notes and files do.
    const openable = selected.flatMap((path) => {
      const node = nodes.get(path);
      return node && node.type !== 'folder' ? [node] : [];
    });
    const items: ContextMenuItem[] = [
      {
        kind: 'item',
        label: openable.length === selected.length ? `Open ${what}` : `Open ${openable.length} of ${what}`,
        icon: 'open-new-tab',
        disabled: openable.length === 0,
        action: () => openable.forEach((node) => this.tabsState.openNoteInBackground({ id: node.relPath, title: node.name })),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Copy',
        icon: 'copy',
        shortcut: 'Ctrl+C',
        disabled: !this.canRunTreeCommand('copy'),
        action: () => this.runTreeCommand('copy'),
      },
      { kind: 'item', label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', action: () => this.runTreeCommand('cut') },
      { kind: 'separator' },
    ];
    if (selected.some((path) => path.includes('/'))) {
      items.push({
        kind: 'item',
        label: `Move ${what} to Root`,
        icon: 'move-to-root',
        action: () => void this.onNotesDropped({ relPaths: selected, destRelDir: '' }),
      });
      items.push({ kind: 'separator' });
    }
    const markdown = this.encryptionActions.markdownNotesIn(selected);
    const mantle = this.encryptionActions.mantleNotesIn(selected);
    if (markdown.length > 0) items.push(this.convertMenuItem(markdown));
    if (mantle.length > 0) items.push(this.toMarkdownMenuItem(mantle));
    if (markdown.length > 0 || mantle.length > 0) items.push({ kind: 'separator' });
    if (allNotes) {
      const allFavorites = selected.every((path) => this.favorites.isFavorite(path));
      items.push({
        kind: 'item',
        label: allFavorites ? `Remove ${what} from Favorites` : `Add ${what} to Favorites`,
        icon: allFavorites ? 'unfavorite' : 'favorite',
        action: () => (allFavorites ? this.favorites.remove(selected) : this.favorites.add(selected)),
      });
      items.push({ kind: 'separator' });
    }
    items.push({ kind: 'item', label: `Delete ${what}`, icon: 'delete', danger: true, action: () => void this.deleteSelection() });
    this.contextMenuState.open(event, items);
    return true;
  }

  /** Converts the Markdown files `notes` found in a selection or folder, at any depth. */
  private convertMenuItem(notes: VaultNoteNode[]): ContextMenuItem {
    const count = notes.length;
    return {
      kind: 'item',
      label: count === 1 ? 'Convert 1 Markdown File to a Mantle Note' : `Convert ${count} Markdown Files to Mantle Notes`,
      icon: 'convert',
      action: () => void this.encryptionActions.convertToNotes(notes),
    };
  }

  /** Converts the Mantle notes `notes` found in a selection or folder back to Markdown files. */
  private toMarkdownMenuItem(notes: VaultNoteNode[]): ContextMenuItem {
    const count = notes.length;
    return {
      kind: 'item',
      label: count === 1 ? 'Convert 1 Note to Markdown…' : `Convert ${count} Notes to Markdown…`,
      icon: 'convert',
      action: () => this.markdownExport.openConvert(notes),
    };
  }

  protected onFolderContextMenu(payload: { event: MouseEvent; folder: VaultFolderNode }): void {
    const { event, folder } = payload;
    if (this.openSelectionMenu(event, folder.relPath)) return;
    const markdown = this.encryptionActions.markdownNotesIn([folder.relPath]);
    const mantle = this.encryptionActions.mantleNotesIn([folder.relPath]);
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
      { kind: 'item', label: 'Rename', icon: 'rename', action: () => this.renameState.renamingPath.set(folder.relPath) },
      { kind: 'separator' },
      ...(markdown.length > 0 ? [this.convertMenuItem(markdown)] : []),
      ...(mantle.length > 0 ? [this.toMarkdownMenuItem(mantle)] : []),
      ...(markdown.length > 0 || mantle.length > 0 ? [{ kind: 'separator' as const }] : []),
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
    const favorite = this.favorites.isFavorite(relPath);
    return {
      kind: 'item',
      label: favorite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: favorite ? 'unfavorite' : 'favorite',
      action: () => this.favorites.toggle(relPath),
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
      { kind: 'item', label: 'Remove from Favorites', icon: 'unfavorite', action: () => this.favorites.remove([note.relPath]) },
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
      this.favorites.place([reference], before);
      return;
    }
    const raw = event.dataTransfer?.getData(VAULT_NOTE_DRAG_MIME);
    if (!raw) return;
    try {
      this.favorites.place(JSON.parse(raw) as string[], before);
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

  /** Moves dropped tree items (notes, folders, files) into `destRelDir`. */
  protected async onNotesDropped(payload: { relPaths: string[]; destRelDir: string }): Promise<void> {
    try {
      await this.vaultActions.move(payload.relPaths, payload.destRelDir);
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Move Failed', tone: 'error' });
    } finally {
      this.selectionState.clear();
    }
  }

  protected async onFolderDropped(payload: { relPath: string; destRelDir: string }): Promise<void> {
    try {
      await this.vaultActions.move([payload.relPath], payload.destRelDir);
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Move Failed', tone: 'error' });
    }
  }

  protected async onNoteRenamed(payload: { relPath: string; newName: string }): Promise<void> {
    try {
      await this.vaultActions.rename('note', payload.relPath, payload.newName);
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Rename Failed', tone: 'error' });
    }
  }

  protected async onFolderRenamed(payload: { relPath: string; newName: string }): Promise<void> {
    try {
      await this.vaultActions.rename('folder', payload.relPath, payload.newName);
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Rename Failed', tone: 'error' });
    }
  }

  private async deleteNote(note: VaultNoteNode): Promise<void> {
    const { confirmed, attachments } = await this.attachments.confirmDeleteNotes([note.relPath], {
      title: 'Delete Note',
      message: `Move "${note.name}" to the system trash?`,
      scope: 'note',
    });
    if (!confirmed) return;
    try {
      await this.vaultActions.delete([note], attachments);
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Delete Failed', tone: 'error' });
    }
  }

  private async deleteFolder(folder: VaultFolderNode): Promise<void> {
    const affectedNotePaths = [...flattenVaultNotes(folder).keys()];
    const { confirmed, attachments } = await this.attachments.confirmDeleteNotes(affectedNotePaths, {
      title: 'Delete Folder',
      message: `Move "${folder.name}" and everything inside it to the system trash?`,
      scope: 'folder',
    });
    if (!confirmed) return;
    try {
      await this.vaultActions.delete([folder], attachments);
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Delete Failed', tone: 'error' });
    }
  }

  /** Deletes the selection, if the focused tree row is part of one, or else that row's item. */
  private deleteFocused(target: HTMLElement): void {
    const path = target.closest<HTMLElement>('[data-tree-path]')?.dataset['treePath'];
    const selected = this.selectionState.selected();
    if (selected.size > 1 && (path === undefined || selected.has(path))) return void this.deleteSelection();
    const node = this.nodesByPath().get(path ?? [...selected][0] ?? '');
    if (node?.type === 'note') void this.deleteNote(node);
    else if (node?.type === 'folder') void this.deleteFolder(node);
    else if (node?.type === 'file') void this.deleteFile(node);
  }

  /** Deletes every selected item: notes, folders (with their contents) and files. */
  private async deleteSelection(): Promise<void> {
    const nodes = this.nodesByPath();
    const items = topmostPaths([...this.selectionState.selected()]).flatMap((path) => nodes.get(path) ?? []);
    const notePaths = items.flatMap((node) =>
      node.type === 'folder' ? [...flattenVaultNotes(node).keys()] : node.type === 'note' ? [node.relPath] : [],
    );
    const allNotes = items.every((node) => node.type === 'note');
    const { confirmed, attachments } = await this.attachments.confirmDeleteNotes(notePaths, {
      title: allNotes ? 'Delete Notes' : 'Delete Items',
      message: allNotes
        ? `Move ${items.length} notes to the system trash?`
        : `Move ${items.length} items, and everything inside the selected folders, to the system trash?`,
      scope: 'notes',
    });
    if (!confirmed) return;
    try {
      // Attachments only go along once every note they belonged to has.
      await this.vaultActions.delete(items, attachments);
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Delete Failed', tone: 'error' });
    } finally {
      this.selectionState.clear();
    }
  }

  /**
   * Ctrl/Cmd+A, C, X and V in the tree: the Edit menu's commands, for its
   * items. Delete (or Cmd+Backspace, a Mac keyboard having no Delete key) is
   * the right-click menu's Delete.
   */
  protected onTreeKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea') || event.shiftKey || event.altKey) return;
    if (event.key === 'Delete' ? !event.ctrlKey && !event.metaKey : event.key === 'Backspace' && event.metaKey) {
      event.preventDefault();
      this.deleteFocused(target);
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const command = ({ a: 'selectAll', c: 'copy', x: 'cut', v: 'paste' } as const)[event.key.toLowerCase()];
    if (!command) return;
    event.preventDefault();
    this.onTreeFocusIn(event);
    if (this.canRunTreeCommand(command)) this.runTreeCommand(command);
  }

  /**
   * The tree item that last had focus, which Paste and Select All work
   * around. Kept past the tree losing focus, so the Edit menu can use it.
   */
  private lastFocusedTreePath: string | undefined;

  protected onTreeFocusIn(event: Event): void {
    this.lastFocusedTreePath = (event.target as HTMLElement).closest<HTMLElement>('[data-tree-path]')?.dataset['treePath'];
  }

  private canRunTreeCommand(command: TreeEditCommand): boolean {
    const selected = [...this.selectionState.selected()];
    switch (command) {
      case 'copy':
        return selected.length > 0 && selected.every((path) => this.nodesByPath().get(path)?.type === 'note');
      case 'cut':
        return selected.length > 0;
      case 'paste':
        return !!this.clipboardState.entry();
      default:
        return !!this.visibleTree();
    }
  }

  private runTreeCommand(command: TreeEditCommand): void {
    const selected = [...this.selectionState.selected()];
    if (command === 'copy') this.clipboardState.copy(selected);
    else if (command === 'cut') this.clipboardState.cut(selected);
    else if (command === 'paste') {
      // Into the focused folder, or beside the focused item; the vault root otherwise.
      const focused = this.lastFocusedTreePath;
      void this.pasteInto(focused === undefined ? '' : this.nodesByPath().get(focused)?.type === 'folder' ? focused : dirOf(focused));
    } else {
      // Everything at any depth in the folder holding the focused item.
      const focused = this.lastFocusedTreePath;
      const tree = this.visibleTree();
      const folder = tree && findFolder(tree, focused ? dirOf(focused) : '');
      if (folder) this.selectionState.selectAll([...flattenTreeNodes(folder).keys()]);
    }
  }

  private async pasteInto(destRelDir: string): Promise<void> {
    const clip = this.clipboardState.entry();
    if (!clip) return;
    try {
      if (clip.mode === 'copy') {
        for (const relPath of clip.relPaths) await this.vaultActions.copy(relPath, destRelDir);
      } else {
        this.clipboardState.clear();
        await this.onNotesDropped({ relPaths: clip.relPaths, destRelDir });
      }
    } catch (err) {
      await this.dialogState.alert(String(err), { title: 'Paste Failed', tone: 'error' });
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
