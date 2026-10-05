import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { formatError, logError } from '../core/logger';
import { CredentialsState } from './credentials-state';
import { VaultMetaState } from './vault-meta-state';
import { VaultState } from './vault-state';
import { VaultNoteNode, flattenAllNotes, isNoteLocked } from './vault-tree.model';

function isEncryptedPath(relPath: string): boolean {
  return relPath.endsWith('.mntl.enc');
}

/**
 * Favorites across the two places they live: a plaintext note's in
 * `.mantle/state.json` (`VaultMetaState`, in a manual order), and an encrypted
 * note's sealed inside the note itself, so a locked vault doesn't reveal which
 * of its notes are favorites. A sealed favorite is only known while its
 * profile is unlocked.
 *
 * An encrypted note listed in `state.json` — favorited before favorites were
 * sealed, or just encrypted — has its favorite moved into the note as soon as
 * its profile is unlocked.
 */
@Injectable({ providedIn: 'root' })
export class FavoritesState {
  private readonly vaultState = inject(VaultState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly credentialsState = inject(CredentialsState);
  private readonly migrating = new Set<string>();

  private readonly notesByPath = computed(() => {
    const tree = this.vaultState.tree();
    return new Map(tree ? flattenAllNotes(tree).map((note) => [note.relPath, note]) : []);
  });

  /**
   * Favorites to show, in display order: plaintext ones in their stored
   * order, then those of unlocked encrypted notes. A favorite whose file is
   * missing (e.g. removed outside the app) is hidden, not dropped.
   */
  readonly notes = computed<VaultNoteNode[]>(() => {
    const byPath = this.notesByPath();
    const plaintext = this.vaultMeta.favorites().flatMap((relPath) => {
      const note = byPath.get(relPath);
      return note && !note.encrypted ? [note] : [];
    });
    const sealed = [...byPath.values()].filter((note) => note.encrypted && note.favorite);
    return [...plaintext, ...sealed];
  });

  constructor() {
    effect(() => {
      const byPath = this.notesByPath();
      const unlocked = this.credentialsState.unlockedIds();
      for (const relPath of this.vaultMeta.favorites()) {
        const note = byPath.get(relPath);
        if (!note?.encrypted || isNoteLocked(note, unlocked) || this.migrating.has(relPath)) continue;
        this.migrating.add(relPath);
        untracked(() => void this.migrate(note));
      }
    });
  }

  isFavorite(relPath: string): boolean {
    if (isEncryptedPath(relPath)) return this.notesByPath().get(relPath)?.favorite ?? false;
    return this.vaultMeta.isFavorite(relPath);
  }

  toggle(relPath: string): void {
    if (this.isFavorite(relPath)) this.remove([relPath]);
    else this.add([relPath]);
  }

  add(relPaths: readonly string[]): void {
    this.place(relPaths, null);
  }

  remove(relPaths: readonly string[]): void {
    this.vaultMeta.removeFavorites(relPaths);
    for (const relPath of relPaths.filter(isEncryptedPath)) {
      if (this.isFavorite(relPath)) void this.seal(relPath, false);
    }
  }

  /**
   * Adds `relPaths` and moves the plaintext ones right before `beforeRelPath`
   * (see `VaultMetaState.placeFavorites`). Encrypted ones have no stored
   * position; they always follow the plaintext favorites.
   */
  place(relPaths: readonly string[], beforeRelPath: string | null): void {
    const plaintext = relPaths.filter((relPath) => !isEncryptedPath(relPath));
    if (plaintext.length > 0) {
      const anchor = beforeRelPath !== null && !isEncryptedPath(beforeRelPath) ? beforeRelPath : null;
      this.vaultMeta.placeFavorites(plaintext, anchor);
    }
    for (const relPath of relPaths.filter(isEncryptedPath)) {
      if (!this.isFavorite(relPath)) void this.seal(relPath, true);
    }
  }

  /** Sets an encrypted note's sealed favorite flag, asking to unlock its profile first if needed. */
  private async seal(relPath: string, favorite: boolean): Promise<boolean> {
    const root = this.vaultState.rootPath();
    const note = this.notesByPath().get(relPath);
    if (!root || !note) return false;
    if (!(await this.credentialsState.promptUnlock(note.profile))) return false;
    try {
      await invoke('set_note_favorite', { vaultRoot: root, relPath, favorite });
      this.vaultState.setNoteFavoriteInTree(relPath, favorite);
      return true;
    } catch (err) {
      logError(`Failed to update favorite of "${relPath}": ${formatError(err)}`);
      return false;
    }
  }

  private async migrate(note: VaultNoteNode): Promise<void> {
    if (note.favorite || (await this.seal(note.relPath, true))) this.vaultMeta.removeFavorites([note.relPath]);
    this.migrating.delete(note.relPath);
  }
}
