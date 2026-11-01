import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { formatError, logError } from '../core/logger';
import { CredentialsState } from './credentials-state';
import { VaultHistoryState } from './vault-history-state';
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
  private readonly history = inject(VaultHistoryState);
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
    const before = this.vaultMeta.favorites();
    this.vaultMeta.removeFavorites(relPaths);
    const sealed = relPaths.filter((relPath) => isEncryptedPath(relPath) && this.isFavorite(relPath));
    for (const relPath of sealed) void this.seal(relPath, false);
    this.recordChange('Remove from Favorites', before, sealed, false);
  }

  /**
   * Adds `relPaths` and moves the plaintext ones right before `beforeRelPath`
   * (see `VaultMetaState.placeFavorites`). Encrypted ones have no stored
   * position; they always follow the plaintext favorites.
   */
  place(relPaths: readonly string[], beforeRelPath: string | null): void {
    const before = this.vaultMeta.favorites();
    const adding = relPaths.some((relPath) => !this.isFavorite(relPath));
    const sealed = relPaths.filter((relPath) => isEncryptedPath(relPath) && !this.isFavorite(relPath));
    const plaintext = relPaths.filter((relPath) => !isEncryptedPath(relPath));
    if (plaintext.length > 0) {
      const anchor = beforeRelPath !== null && !isEncryptedPath(beforeRelPath) ? beforeRelPath : null;
      this.vaultMeta.placeFavorites(plaintext, anchor);
    }
    for (const relPath of sealed) void this.seal(relPath, true);
    this.recordChange(adding ? 'Add to Favorites' : 'Reorder Favorites', before, sealed, true);
  }

  /** Undo for a change from `before`, which also set the sealed flag of `sealed` to `favorite`. */
  private recordChange(label: string, before: readonly string[], sealed: readonly string[], favorite: boolean): void {
    const after = this.vaultMeta.favorites();
    if (after === before && sealed.length === 0) return;
    const apply = async (list: readonly string[], flag: boolean) => {
      this.vaultMeta.setFavorites(list);
      for (const relPath of sealed) if (!(await this.seal(relPath, flag))) return false;
      return true;
    };
    this.history.record({ label, undo: () => apply(before, !favorite), redo: () => apply(after, favorite) });
  }

  /** Sets an encrypted note's sealed favorite flag, asking to unlock its profile first if needed. */
  private async seal(relPath: string, favorite: boolean): Promise<boolean> {
    const root = this.vaultState.rootPath();
    const note = this.notesByPath().get(relPath);
    if (!root || !note) return false;
    if (!(await this.credentialsState.promptUnlock(note.profile))) return false;
    try {
      await invoke('set_note_favorite', { relPath, favorite });
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
