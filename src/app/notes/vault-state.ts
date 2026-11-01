import { Injectable, computed, effect, inject, Injector, signal, untracked } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { join } from '@tauri-apps/api/path';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { flattenVaultNotes, hiddenTreePaths, withNoteFields, withRenamedNote, VaultFolderNode } from './vault-tree.model';
import { NotesState } from './notes-state';
import { TabsState } from './tabs-state';
import { VaultMetaState } from './vault-meta-state';
import { VaultRootState } from './vault-root-state';
import { formatError, logError, logInfo } from '../core/logger';
import { ItemStyle } from '../shared/item-style/item-style';
import { FolderPickerState } from '../shared/folder-picker/folder-picker-state';

/** Vault display name, derived from the trailing path segment (handles both `/` and `\` separators). */
export function vaultNameFromPath(path: string): string {
  const segments = path.split(/[/\\]+/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export interface CreatedNote {
  name: string;
  relPath: string;
}

/** Mirrors `ImportReport` in `migrate.rs`. */
export interface ImportReport {
  notes: number;
  files: number;
  failed: { relPath: string; error: string }[];
}

export interface CreatedFolder {
  name: string;
  relPath: string;
}

@Injectable({ providedIn: 'root' })
export class VaultState {
  private readonly tabsState = inject(TabsState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly folderPicker = inject(FolderPickerState);
  // Looked up late: NotesState depends on this service.
  private readonly injector = inject(Injector);

  private readonly rootState = inject(VaultRootState);
  readonly rootPath = this.rootState.path;
  readonly tree = signal<VaultFolderNode | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Most-recently-opened vault paths, newest first, for the sidebar vault switcher. */
  readonly recentVaults = this.rootState.recents;

  /** True while the welcome screen is shown over an open vault ("Manage Vaults"). Cleared when the vault changes. */
  readonly managing = signal(false);

  /** How many hidden notes each locked profile has, by profile id: the tree can't list them. */
  readonly lockedHidden = computed<Readonly<Record<string, number>>>(() => this.tree()?.lockedHidden ?? {});

  /** Hidden notes and virtual folders in the tree, which are never recorded in plaintext. */
  readonly hiddenPaths = computed(() => {
    const tree = this.tree();
    return tree ? hiddenTreePaths(tree) : new Set<string>();
  });

  /** Baseline from the last scan, used to detect externally-added/removed notes. Reset across vault switches. */
  private previousRoot: string | null = null;
  private previousNotes: Map<string, string> | null = null;

  /** relPath of the note that just became active and is waiting to appear in the tree before being recorded as recent. */
  private pendingRecent: string | null = null;

  private readonly activeNoteId = computed(() => {
    const activeId = this.tabsState.activeId();
    return this.tabsState.tabs().find((tab) => tab.id === activeId)?.noteId ?? null;
  });

  constructor() {
    effect(() => {
      this.rootPath();
      untracked(() => this.managing.set(false));
    });

    // Load the vault's `.mantle/state.json` (recent notes, ...) alongside the vault itself.
    effect(() => {
      const path = this.rootPath();
      untracked(() => {
        this.pendingRecent = null;
        if (path) void this.vaultMeta.load(path);
        else this.vaultMeta.unload();
      });
    });

    // A note becoming the active tab counts as opening it. The tab restored at
    // launch is already active before the metadata finishes loading, so it is
    // (deliberately) never recorded. A note that isn't in the tree yet — e.g.
    // one just created, before the watcher's rescan — waits for the tree.
    effect(() => {
      const relPath = this.activeNoteId();
      untracked(() => {
        this.pendingRecent = this.vaultMeta.loaded() ? relPath : null;
        this.recordPendingRecent();
      });
    });
    effect(() => {
      this.tree();
      untracked(() => this.recordPendingRecent());
    });

    effect(() => {
      const hidden = this.hiddenPaths();
      untracked(() => {
        this.tabsState.setHiddenNoteIds(hidden);
        this.vaultMeta.setHiddenPaths(hidden);
      });
    });

    // Keep a native filesystem watcher pointed at the current vault so
    // changes made outside the app (OS file explorer, other editors) are
    // picked up too.
    effect(() => {
      const path = this.rootPath();
      if (path) {
        void invoke('start_vault_watch').catch((err) => {
          logError(`Failed to watch vault "${path}" for external changes: ${formatError(err)}`);
        });
      } else {
        void invoke('stop_vault_watch').catch(() => {
          // no watcher running — ignore
        });
      }
    });

    void listen('vault-changed', () => {
      void this.refresh();
    });

    if (this.rootPath()) {
      void this.refresh();
    }
  }

  /**
   * Writes out pending edits. The backend acts on the active vault, so this
   * runs before it changes, or they'd land in the next one.
   */
  private async settle(): Promise<void> {
    await this.injector.get(NotesState).flushPending();
    this.vaultMeta.flush();
  }

  /** Adopts the vault the backend just made active (null: the user cancelled) and its updated recents. */
  private async opened(path: string | null): Promise<boolean> {
    if (!path) return false;
    await this.rootState.load();
    await this.refresh();
    return true;
  }

  async pickVault(): Promise<void> {
    if (!(await this.folderPicker.approve('vault', 'Open a Vault'))) return;
    await this.settle();
    await this.opened(await invoke<string | null>('pick_vault'));
  }

  /**
   * Copies an Obsidian vault into a new Mantle vault and opens it: the backend
   * asks for the Obsidian vault, then for where the new vault goes. Resolves
   * what the import did, or null if a dialog was cancelled.
   */
  async importObsidianVault(): Promise<ImportReport | null> {
    if (!(await this.folderPicker.approve('obsidianSource', 'Choose an Obsidian Vault'))) return null;
    if (!(await this.folderPicker.approve('obsidianDest', 'Create the New Mantle Vault', 'Obsidian Vault (Mantle)'))) return null;
    this.error.set(null);
    try {
      await this.settle();
      const result = await invoke<{ path: string; report: ImportReport } | null>('import_obsidian_vault');
      if (!result) return null;
      logInfo(`Imported into "${result.path}": ${result.report.notes} notes, ${result.report.failed.length} failed`);
      await this.opened(result.path);
      return result.report;
    } catch (err) {
      logError(`Failed to import an Obsidian vault: ${formatError(err)}`);
      this.error.set(formatError(err));
      return null;
    }
  }

  /**
   * Creates a new, empty vault and opens it. The backend's save dialog picks
   * both the location and the name in one step; it creates that folder
   * (refusing one that already exists) and seeds its `.mantle/` state.
   */
  async createVault(): Promise<void> {
    if (!(await this.folderPicker.approve('newVault', 'Create New Vault', 'New Vault'))) return;
    this.error.set(null);
    try {
      await this.settle();
      const path = await invoke<string | null>('create_vault');
      if (path) logInfo(`Created vault "${path}"`);
      await this.opened(path);
    } catch (err) {
      logError(`Failed to create a vault: ${formatError(err)}`);
      this.error.set(formatError(err));
    }
  }

  /** Switches to an already-known vault path (e.g. from the sidebar's recent-vaults switcher). */
  async switchVault(path: string): Promise<void> {
    if (path === this.rootPath()) return;
    try {
      await this.settle();
      await this.opened(await invoke<string>('switch_vault', { path }));
    } catch (err) {
      logError(`Failed to open vault "${path}": ${formatError(err)}`);
      this.error.set(formatError(err));
    }
  }

  /** Closes the open vault and any tabs into it, returning to the no-vault-open state. */
  async closeVault(): Promise<void> {
    await this.settle();
    void invoke('close_vault').catch((err) => logError(`Failed to close the vault: ${formatError(err)}`));
    this.rootPath.set(null);
    this.tree.set(null);
    this.error.set(null);
    this.previousRoot = null;
    this.previousNotes = null;
    this.tabsState.closeAllTabs();
  }

  /** Forgets `path` from the recent-vaults list; the folder itself is untouched. */
  removeRecentVault(path: string): void {
    this.recentVaults.update((paths) => paths.filter((p) => p !== path));
    void invoke('remove_recent_vault', { path }).catch((err) => logError(`Failed to forget "${path}": ${formatError(err)}`));
  }

  clearRecentVaults(): void {
    this.recentVaults.set([]);
    void invoke('clear_recent_vaults').catch((err) => logError(`Failed to clear recent vaults: ${formatError(err)}`));
  }

  /**
   * Moves the vault folder at `from`: to where the backend's save dialog says,
   * or, given `newName`, renamed in place. Moving the open vault reopens it
   * at its new path; callers must flush pending writes (and drop unlocked
   * keys, which belong to the old path) first. Returns false if it was
   * cancelled or failed (then `error` is set).
   */
  async moveVault(from: string, newName?: string): Promise<boolean> {
    if (!newName && !(await this.folderPicker.approve('moveTo', 'Move Vault', vaultNameFromPath(from)))) return false;
    const isOpen = from === this.rootPath();
    this.error.set(null);
    // The watcher holds a handle on the vault folder, which can block renaming it on Windows.
    if (isOpen) await invoke('stop_vault_watch').catch(() => {});
    try {
      await this.settle();
      const to = await invoke<string | null>('move_vault', newName ? { from, newName } : { from });
      if (!to) {
        if (isOpen) void invoke('start_vault_watch').catch(() => {});
        return false;
      }
      logInfo(`Moved vault "${from}" to "${to}"`);
      await this.rootState.load();
      if (isOpen) await this.refresh();
      return true;
    } catch (err) {
      logError(`Failed to move vault "${from}": ${formatError(err)}`);
      this.error.set(formatError(err));
      if (isOpen) void invoke('start_vault_watch').catch(() => {});
      return false;
    }
  }

  private recordPendingRecent(): void {
    const relPath = this.pendingRecent;
    const tree = this.tree();
    if (!relPath || !tree || !flattenVaultNotes(tree).has(relPath)) return;
    this.pendingRecent = null;
    this.vaultMeta.recordOpened(relPath);
  }

  async refresh(): Promise<void> {
    const root = this.rootPath();
    if (!root) return;
    this.loading.set(true);
    let tree: VaultFolderNode;
    try {
      logInfo(`Scanning vault "${root}"`);
      tree = await invoke<VaultFolderNode>('scan_vault');
    } catch (err) {
      // A rescan of the open vault can fail transiently (e.g. a sync tool
      // holding a file); keep showing what we had rather than blanking it.
      if (this.previousRoot === root && this.tree()) {
        logError(`Failed to rescan vault "${root}": ${formatError(err)}`);
      } else {
        logError(`Failed to open vault "${root}": ${formatError(err)}`);
        this.error.set(formatError(err));
        this.tree.set(null);
      }
      return;
    } finally {
      this.loading.set(false);
    }

    this.error.set(null);
    this.tree.set(tree);
    // Only the scan means the vault couldn't be opened; a bug in following
    // it up must not take the whole tree down with it.
    try {
      const notes = flattenVaultNotes(tree);
      if (this.previousRoot === root && this.previousNotes) {
        this.reconcileTabs(this.previousNotes, notes);
      }
      this.previousRoot = root;
      this.previousNotes = notes;
    } catch (err) {
      logError(`Failed to update tabs after scanning "${root}": ${formatError(err)}`);
    }
  }

  /**
   * Diffs the previous and current note listings and updates open tabs to
   * match: a single removed+added pair is treated as a rename/move (tabs
   * are retargeted), anything else removed is flagged as missing on its
   * tab(s), and anything that reappeared has its missing flag cleared.
   */
  private reconcileTabs(before: Map<string, string>, after: Map<string, string>): void {
    const removed = [...before.keys()].filter((relPath) => !after.has(relPath));
    const added = [...after.keys()].filter((relPath) => !before.has(relPath));

    if (removed.length === 1 && added.length === 1) {
      const [oldPath] = removed;
      const [newPath] = added;
      this.tabsState.renameNoteId(oldPath, newPath, after.get(newPath)!);
      this.vaultMeta.renameNote(oldPath, newPath);
      return;
    }

    // Favorites are deliberately kept here: a note that vanished outside the
    // app may just be mid-sync, and its favorite should come back with it.
    for (const relPath of removed) {
      this.tabsState.markMissing(relPath);
      this.vaultMeta.removeRecent(relPath);
    }
    for (const relPath of added) this.tabsState.clearMissing(relPath);
  }

  async createNote(relDir: string, name: string): Promise<CreatedNote> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    const created = await invoke<CreatedNote>('create_note', {
      relDir,
      name,
    });
    return created;
  }

  /** Creates an "Untitled" note in `relDir` (the vault root by default; retrying on name collisions) and opens it in a new tab. */
  async createAndOpenNote(relDir = ''): Promise<CreatedNote | null> {
    const base = 'Untitled';
    for (let i = 0; i < 50; i++) {
      const name = i === 0 ? base : `${base} ${i + 1}`;
      try {
        const created = await this.createNote(relDir, name);
        this.tabsState.openInNewTab({ id: created.relPath, title: created.name });
        return created;
      } catch {
        // name collision — try the next candidate
      }
    }
    return null;
  }

  async createFolder(relDir: string, name: string): Promise<CreatedFolder> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedFolder>('create_folder', { relDir, name });
  }

  /** Creates a "New Folder" in `relDir` (retrying on name collisions). */
  async createFolderWithUniqueName(relDir = ''): Promise<CreatedFolder> {
    const base = 'New Folder';
    for (let i = 0; i < 50; i++) {
      const name = i === 0 ? base : `${base} ${i + 1}`;
      try {
        return await this.createFolder(relDir, name);
      } catch {
        // name collision — try the next candidate
      }
    }
    throw new Error('Could not find an available folder name');
  }

  async deleteNote(relPath: string): Promise<void> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    await invoke('delete_note', { relPath });
  }

  /** Moves a file that isn't a note to the trash; `delete_note` trashes whatever path it's given. */
  async deleteFile(relPath: string): Promise<void> {
    await this.deleteNote(relPath);
  }

  async deleteFolder(relPath: string): Promise<void> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    await invoke('delete_folder', { relPath });
  }

  /**
   * Optimistically renames a note in the in-memory tree without a full rescan
   * — used for live title edits and right after a rename completes, so the
   * sidebar updates immediately instead of waiting on the filesystem
   * watcher's `vault-changed` refresh.
   */
  renameNoteInTree(relPath: string, newRelPath: string, newName: string): void {
    const tree = this.tree();
    if (!tree) return;
    this.tree.set(withRenamedNote(tree, relPath, newRelPath, newName));
  }

  /**
   * Optimistically updates a note's tags in the in-memory tree, so the
   * sidebar's Tags section follows an edit at once. Saving an encrypted note
   * doesn't wake the filesystem watcher, so no rescan would pick it up.
   */
  setNoteTagsInTree(relPath: string, tags: string[]): void {
    const tree = this.tree();
    if (!tree) return;
    this.tree.set(withNoteFields(tree, relPath, { tags }));
  }

  /** Like `setNoteTagsInTree`, for an encrypted note's sealed favorite flag. */
  setNoteFavoriteInTree(relPath: string, favorite: boolean): void {
    const tree = this.tree();
    if (!tree) return;
    this.tree.set(withNoteFields(tree, relPath, { favorite }));
  }

  /** Like `setNoteTagsInTree`, for an encrypted note's sealed icon and color. */
  setNoteStyleInTree(relPath: string, style: ItemStyle | null): void {
    const tree = this.tree();
    if (!tree) return;
    this.tree.set(withNoteFields(tree, relPath, { icon: style?.icon, color: style?.color }));
  }

  async renameNote(relPath: string, newName: string): Promise<CreatedNote> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedNote>('rename_note', { relPath, newName });
  }

  async renameFolder(relPath: string, newName: string): Promise<CreatedFolder> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedFolder>('rename_folder', { relPath, newName });
  }

  async duplicateNote(relPath: string): Promise<CreatedNote> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedNote>('duplicate_note', { relPath });
  }

  async copyNote(sourceRelPath: string, destRelDir: string): Promise<CreatedNote> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedNote>('copy_note', {
      sourceRelPath,
      destRelDir,
    });
  }

  async moveNote(sourceRelPath: string, destRelDir: string): Promise<CreatedNote> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    const created = await invoke<CreatedNote>('move_note', {
      sourceRelPath,
      destRelDir,
    });
    return created;
  }

  async moveFolder(sourceRelPath: string, destRelDir: string): Promise<CreatedFolder> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedFolder>('move_folder', {
      sourceRelPath,
      destRelDir,
    });
  }

  /** Moves a file that isn't a note; `move_folder` is a plain rename that keeps the name as-is. */
  async moveFile(sourceRelPath: string, destRelDir: string): Promise<CreatedFolder> {
    return this.moveFolder(sourceRelPath, destRelDir);
  }

  /**
   * Reveals `relPath` (or the vault root, if empty) in the OS file explorer.
   * A hidden note's file isn't at its relPath, so the backend says where it is.
   */
  async revealInFileExplorer(relPath: string): Promise<void> {
    const root = this.rootPath();
    if (!root) return;
    const absolute = relPath.endsWith('.mntl.enc')
      ? await invoke<string>('note_disk_path', { relPath })
      : relPath
        ? await join(root, ...relPath.split('/'))
        : root;
    await revealItemInDir(absolute);
  }
}
