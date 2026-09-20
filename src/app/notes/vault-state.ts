import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { flattenVaultNotes, withRenamedNote, VaultFolderNode } from './vault-tree.model';
import { TabsState } from './tabs-state';
import { VaultMetaState } from './vault-meta-state';
import { formatError, logError, logInfo } from '../core/logger';

const STORAGE_KEY = 'mantle.vault.v1';
const RECENT_KEY = 'mantle.vault.recent.v1';
const MAX_RECENT_VAULTS = 8;

function readStoredPath(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function readStoredRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Vault display name, derived from the trailing path segment (handles both `/` and `\` separators). */
export function vaultNameFromPath(path: string): string {
  const segments = path.split(/[/\\]+/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export interface CreatedNote {
  name: string;
  relPath: string;
}

export interface CreatedFolder {
  name: string;
  relPath: string;
}

@Injectable({ providedIn: 'root' })
export class VaultState {
  private readonly tabsState = inject(TabsState);
  private readonly vaultMeta = inject(VaultMetaState);

  readonly rootPath = signal<string | null>(readStoredPath());
  readonly tree = signal<VaultFolderNode | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Most-recently-opened vault paths, newest first, for the sidebar vault switcher. */
  readonly recentVaults = signal<string[]>(readStoredRecents());

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
      const path = this.rootPath();
      try {
        if (path) localStorage.setItem(STORAGE_KEY, path);
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        // storage unavailable (e.g. private browsing) — ignore
      }
    });

    effect(() => {
      const path = this.rootPath();
      if (path) this.rememberRecentVault(path);
    });

    effect(() => {
      const recents = this.recentVaults();
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
      } catch {
        // storage unavailable (e.g. private browsing) — ignore
      }
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

    // Keep a native filesystem watcher pointed at the current vault so
    // changes made outside the app (OS file explorer, other editors) are
    // picked up too.
    effect(() => {
      const path = this.rootPath();
      if (path) {
        void invoke('start_vault_watch', { vaultRoot: path }).catch((err) => {
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

  async pickVault(): Promise<void> {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    this.rootPath.set(selected);
    await this.refresh();
  }

  /** Switches to an already-known vault path (e.g. from the sidebar's recent-vaults switcher). */
  async switchVault(path: string): Promise<void> {
    if (path === this.rootPath()) return;
    this.rootPath.set(path);
    await this.refresh();
  }

  /** Closes the open vault and any tabs into it, returning to the no-vault-open state. */
  closeVault(): void {
    this.rootPath.set(null);
    this.tree.set(null);
    this.previousRoot = null;
    this.previousNotes = null;
    this.tabsState.closeAllTabs();
  }

  private recordPendingRecent(): void {
    const relPath = this.pendingRecent;
    const tree = this.tree();
    if (!relPath || !tree || !flattenVaultNotes(tree).has(relPath)) return;
    this.pendingRecent = null;
    this.vaultMeta.recordOpened(relPath);
  }

  private rememberRecentVault(path: string): void {
    const current = untracked(this.recentVaults);
    const next = [path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENT_VAULTS);
    this.recentVaults.set(next);
  }

  async refresh(): Promise<void> {
    const root = this.rootPath();
    if (!root) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      logInfo(`Scanning vault "${root}"`);
      const tree = await invoke<VaultFolderNode>('scan_vault', { vaultRoot: root });
      this.tree.set(tree);

      const notes = flattenVaultNotes(tree);
      if (this.previousRoot === root && this.previousNotes) {
        this.reconcileTabs(this.previousNotes, notes);
      }
      this.previousRoot = root;
      this.previousNotes = notes;
    } catch (err) {
      logError(`Failed to open vault "${root}": ${formatError(err)}`);
      this.error.set(String(err));
      this.tree.set(null);
    } finally {
      this.loading.set(false);
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
      this.vaultMeta.renameRecent(oldPath, newPath);
      return;
    }

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
      vaultRoot: root,
      relDir,
      name,
    });
    return created;
  }

  /** Creates an "Untitled" note at the vault root (retrying on name collisions) and opens it in a new tab. */
  async createAndOpenNote(): Promise<CreatedNote | null> {
    const base = 'Untitled';
    for (let i = 0; i < 50; i++) {
      const name = i === 0 ? base : `${base} ${i + 1}`;
      try {
        const created = await this.createNote('', name);
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
    return invoke<CreatedFolder>('create_folder', { vaultRoot: root, relDir, name });
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
    await invoke('delete_note', { vaultRoot: root, relPath });
  }

  async deleteFolder(relPath: string): Promise<void> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    await invoke('delete_folder', { vaultRoot: root, relPath });
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

  async renameNote(relPath: string, newName: string): Promise<CreatedNote> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedNote>('rename_note', { vaultRoot: root, relPath, newName });
  }

  async renameFolder(relPath: string, newName: string): Promise<CreatedFolder> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedFolder>('rename_folder', { vaultRoot: root, relPath, newName });
  }

  async duplicateNote(relPath: string): Promise<CreatedNote> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedNote>('duplicate_note', { vaultRoot: root, relPath });
  }

  async copyNote(sourceRelPath: string, destRelDir: string): Promise<CreatedNote> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedNote>('copy_note', {
      vaultRoot: root,
      sourceRelPath,
      destRelDir,
    });
  }

  async moveNote(sourceRelPath: string, destRelDir: string): Promise<CreatedNote> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    const created = await invoke<CreatedNote>('move_note', {
      vaultRoot: root,
      sourceRelPath,
      destRelDir,
    });
    return created;
  }

  async moveFolder(sourceRelPath: string, destRelDir: string): Promise<CreatedFolder> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedFolder>('move_folder', {
      vaultRoot: root,
      sourceRelPath,
      destRelDir,
    });
  }

  /** Reveals `relPath` (or the vault root, if empty) in the OS file explorer. */
  async revealInFileExplorer(relPath: string): Promise<void> {
    const root = this.rootPath();
    if (!root) return;
    const absolute = relPath ? await join(root, ...relPath.split('/')) : root;
    await revealItemInDir(absolute);
  }
}
