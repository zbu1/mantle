import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { formatError, logError } from '../core/logger';
import { ItemStyle } from '../shared/item-style/item-style';
import { CredentialsState } from './credentials-state';
import { VaultHistoryState } from './vault-history-state';
import { VaultMetaState } from './vault-meta-state';
import { VaultState } from './vault-state';
import { flattenAllNotes, isNoteLocked } from './vault-tree.model';

const isEncryptedPath = (relPath: string) => relPath.endsWith('.mntl.enc');

function clean(style: ItemStyle | null | undefined): ItemStyle | null {
  return style && (style.icon || style.color) ? { icon: style.icon, color: style.color } : null;
}

/**
 * Icons and colors of notes and folders, across the two places they live: a
 * plaintext note's or a folder's in `.mantle/state.json`, an encrypted note's
 * sealed inside the note (known only while its profile is unlocked). Like
 * favorites, an encrypted note listed in `state.json` (just encrypted) has its
 * style moved into the note once its profile is unlocked.
 */
@Injectable({ providedIn: 'root' })
export class ItemStyleState {
  private readonly vaultState = inject(VaultState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly credentialsState = inject(CredentialsState);
  private readonly history = inject(VaultHistoryState);
  private readonly migrating = new Set<string>();

  private readonly sealed = computed(() => {
    const tree = this.vaultState.tree();
    return new Map(
      tree ? flattenAllNotes(tree).filter((note) => note.encrypted).map((note) => [note.relPath, note] as const) : [],
    );
  });

  constructor() {
    effect(() => {
      const sealed = this.sealed();
      const unlocked = this.credentialsState.unlockedIds();
      for (const relPath of Object.keys(this.vaultMeta.styles())) {
        const note = sealed.get(relPath);
        if (!note || isNoteLocked(note, unlocked) || this.migrating.has(relPath)) continue;
        this.migrating.add(relPath);
        untracked(() => void this.migrate(relPath));
      }
    });
  }

  of(relPath: string): ItemStyle | null {
    if (isEncryptedPath(relPath)) {
      const note = this.sealed().get(relPath);
      return clean(note);
    }
    return this.vaultMeta.styles()[relPath] ?? null;
  }

  /** Sets the style of each of `relPaths` (null clears it) as one undo step. */
  async set(relPaths: readonly string[], style: ItemStyle | null): Promise<void> {
    const next = clean(style);
    const before = relPaths.map((relPath) => [relPath, this.of(relPath)] as const);
    const apply = async (entries: readonly (readonly [string, ItemStyle | null])[]) => {
      for (const [relPath, entry] of entries) if (!(await this.write(relPath, entry))) return false;
      return true;
    };
    const after = relPaths.map((relPath) => [relPath, next] as const);
    if (!(await apply(after))) return;
    this.history.record({ label: next ? 'Change Icon or Color' : 'Remove Icon or Color', undo: () => apply(before), redo: () => apply(after) });
  }

  private async write(relPath: string, style: ItemStyle | null): Promise<boolean> {
    if (!isEncryptedPath(relPath)) {
      this.vaultMeta.setStyle(relPath, style);
      return true;
    }
    const root = this.vaultState.rootPath();
    const note = this.sealed().get(relPath);
    if (!root || !note) return false;
    if (!(await this.credentialsState.promptUnlock(note.profile))) return false;
    try {
      await invoke('set_note_style', { vaultRoot: root, relPath, icon: style?.icon ?? null, color: style?.color ?? null });
      this.vaultState.setNoteStyleInTree(relPath, style);
      return true;
    } catch (err) {
      logError(`Failed to update the style of "${relPath}": ${formatError(err)}`);
      return false;
    }
  }

  private async migrate(relPath: string): Promise<void> {
    const style = this.vaultMeta.styles()[relPath] ?? null;
    if (!style || (await this.write(relPath, style))) this.vaultMeta.setStyle(relPath, null);
    this.migrating.delete(relPath);
  }
}
