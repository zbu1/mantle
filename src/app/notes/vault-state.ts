import { Injectable, effect, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { VaultFolderNode } from './vault-tree.model';

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

@Injectable({ providedIn: 'root' })
export class VaultState {
  readonly rootPath = signal<string | null>(readStoredPath());
  readonly tree = signal<VaultFolderNode | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

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
      this.tree.set(await invoke<VaultFolderNode>('scan_vault', { vaultRoot: root }));
    } catch (err) {
      this.error.set(String(err));
      this.tree.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  async createNote(relDir: string, name: string): Promise<CreatedNote> {
    const root = this.rootPath();
    if (!root) throw new Error('No vault open');
    const created = await invoke<CreatedNote>('create_note', {
      vaultRoot: root,
      relDir,
      name,
    });
    await this.refresh();
    return created;
  }
}
