import { Injectable, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { flattenVaultNotes, withRenamedNote, VaultFolderNode } from './vault-tree.model';
import { TabsState } from './tabs-state';

const STORAGE_KEY = 'mantle.vault.v1';

function readStoredPath(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
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

  readonly rootPath = signal<string | null>(readStoredPath());
  readonly tree = signal<VaultFolderNode | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Baseline from the last scan, used to detect externally-added/removed notes. Reset across vault switches. */
  private previousRoot: string | null = null;
  private previousNotes: Map<string, string> | null = null;

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

    // Keep a native filesystem watcher pointed at the current vault so
    // changes made outside the app (OS file explorer, other editors) are
    // picked up too.
    effect(() => {
      const path = this.rootPath();
      if (path) {
        void invoke('start_vault_watch', { vaultRoot: path }).catch((err) => {
          console.error('Failed to watch vault for external changes:', err);
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

  async refresh(): Promise<void> {
    const root = this.rootPath();
    if (!root) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const tree = await invoke<VaultFolderNode>('scan_vault', { vaultRoot: root });
      this.tree.set(tree);

      const notes = flattenVaultNotes(tree);
      if (this.previousRoot === root && this.previousNotes) {
        this.reconcileTabs(this.previousNotes, notes);
      }
      this.previousRoot = root;
      this.previousNotes = notes;
    } catch (err) {
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
      return;
    }

    for (const relPath of removed) this.tabsState.markMissing(relPath);
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

  async createFolder(relDir: string, name: string): Promise<CreatedFolder> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    return invoke<CreatedFolder>('create_folder', { vaultRoot: root, relDir, name });
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
}
