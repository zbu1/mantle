import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { formatError, logError, logInfo } from '../core/logger';
import { CredentialsState } from './credentials-state';
import { NotesState } from './notes-state';
import { buildTagGroups, normalizeTag, tagKey } from './tags';
import { VaultState } from './vault-state';

/** What the Rust `rename_tag` / `remove_tag` commands return. */
export interface TagEditReport {
  /** Notes that were rewritten. */
  updated: string[];
  /** Encrypted notes in locked profiles, which couldn't be checked for the tag. */
  lockedSkipped: number;
}

/**
 * The vault's tags: the index the sidebar shows, editing one note's tags, and
 * renaming or removing a tag across the whole vault.
 *
 * Tags live in each note's frontmatter, so the index is derived from the
 * vault scan (`VaultState.tree`) rather than stored anywhere of its own.
 */
@Injectable({ providedIn: 'root' })
export class TagsState {
  private readonly vaultState = inject(VaultState);
  private readonly notesState = inject(NotesState);
  private readonly credentialsState = inject(CredentialsState);

  /** Every tag in the vault with the notes that have it, sorted by name. */
  readonly groups = computed(() => {
    const tree = this.vaultState.tree();
    return tree ? buildTagGroups(tree, this.credentialsState.unlockedIds()) : [];
  });

  /** Every tag name in the vault, for autocomplete. */
  readonly names = computed(() => this.groups().map((group) => group.name));

  /**
   * The tag the sidebar should scroll to and highlight, by key. A fresh
   * object each time, so revealing the same tag twice still reacts.
   */
  readonly revealRequest = signal<{ key: string } | null>(null);

  /** Replaces the tags of the (loaded) note `noteId`, e.g. from the editor's tag bar. */
  setNoteTags(noteId: string, tags: string[]): void {
    this.notesState.updateTags(noteId, tags);
    this.vaultState.setNoteTagsInTree(noteId, tags);
  }

  /** Asks the sidebar to show `tag` in its Tags section. */
  reveal(tag: string): void {
    const request = { key: tagKey(tag) };
    this.revealRequest.set(request);
    // The tag's sidebar row consumes the request. If no row ever does (the
    // tag vanished meanwhile), drop it, so a row created later for the same
    // tag doesn't flash out of nowhere.
    setTimeout(() => {
      if (this.revealRequest() === request) this.revealRequest.set(null);
    }, 1000);
  }

  /**
   * Renames `from` to `to` in every note that has it. Renaming onto an
   * existing tag merges the two. Throws with a user-facing message on failure.
   */
  async renameTag(from: string, to: string): Promise<TagEditReport> {
    const normalized = normalizeTag(to);
    if (!normalized) throw new Error(`"${to}" isn't a valid tag.`);
    const report = await this.editVaultWide('rename_tag', { from, to: normalized });
    this.notesState.retagLoaded(from, normalized);
    logInfo(`Renamed tag "${from}" to "${normalized}" in ${report.updated.length} notes`);
    await this.vaultState.refresh();
    return report;
  }

  /** Removes `tag` from every note that has it. Throws with a user-facing message on failure. */
  async removeTag(tag: string): Promise<TagEditReport> {
    const report = await this.editVaultWide('remove_tag', { tag });
    this.notesState.retagLoaded(tag, null);
    logInfo(`Removed tag "${tag}" from ${report.updated.length} notes`);
    await this.vaultState.refresh();
    return report;
  }

  private async editVaultWide(command: string, args: Record<string, string>): Promise<TagEditReport> {
    const root = this.vaultState.rootPath();
    if (!root) throw new Error('No vault is open.');
    // Pending edits are written first: the backend rewrites note files, and a
    // debounced save landing afterwards would put the old tags back.
    await this.notesState.flushPending();
    try {
      return await invoke<TagEditReport>(command, { vaultRoot: root, ...args });
    } catch (err) {
      logError(`Failed to ${command.replace('_', ' ')}: ${formatError(err)}`);
      throw new Error(formatError(err));
    }
  }
}
