import { Injectable, computed, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { formatError, logError, logInfo } from '../core/logger';
import { DialogState } from '../shared/dialog/dialog-state';
import { LinkIndex, linkFixes } from './links';
import { NotesState } from './notes-state';
import { VaultState } from './vault-state';
import { VaultFolderNode, withNoteFields } from './vault-tree.model';

/** What the Rust `rewrite_links` command returns. */
interface LinkRewriteReport {
  updated: string[];
  locked: string[];
}

/**
 * The vault's `[[links]]`: where each leads, which notes link to a note, and
 * keeping them leading there when notes are renamed or moved.
 *
 * Like tags, each note's links are read by the vault scan (`VaultState.tree`)
 * rather than stored anywhere; a locked note's are unknown.
 */
@Injectable({ providedIn: 'root' })
export class NoteLinksState {
  private readonly vaultState = inject(VaultState);
  private readonly notesState = inject(NotesState);
  private readonly dialogState = inject(DialogState);

  readonly index = computed(() => new LinkIndex(this.vaultState.tree()));

  /** Whether hidden notes of a locked profile exist, which a link leading nowhere might be meant for. */
  readonly lockedHiddenNotes = computed(() => Object.values(this.vaultState.lockedHidden()).some((n) => n > 0));

  /** Notes whose links can't be read right now: those of locked profiles. */
  readonly unreadable = computed(() => this.index().notes.filter((note) => note.links === null).length);

  /** The editor saw `noteId`'s links change; keep the index current until the next scan. */
  setLinks(noteId: string, links: string[]): void {
    const tree = this.vaultState.tree();
    const current = tree && this.index().note(noteId);
    if (!current || JSON.stringify(current.links) === JSON.stringify(links)) return;
    this.vaultState.tree.set(withNoteFields(tree, noteId, { links }));
  }

  /**
   * After notes moved (`moved` maps old paths to new), rewrite every link
   * that no longer leads where it did, given the vault as it was `before`.
   * `renamed` says a note's name changed, so locked notes' links (unknown)
   * may now lead nowhere, which is worth saying.
   */
  async fixAfterMove(before: VaultFolderNode | null, moved: (relPath: string) => string, renamed: boolean): Promise<void> {
    const vaultRoot = this.vaultState.rootPath();
    if (!vaultRoot || !before) return;
    const old = new LinkIndex(before);
    let locked = renamed ? old.notes.filter((note) => note.links === null).length : 0;
    // Without a single link there's nothing to fix, nor a rescan to wait for.
    const linked = old.notes.some((note) => note.links?.length);
    if (linked) await this.vaultState.refresh();
    const rewrites = linked ? linkFixes(old, this.index(), moved) : [];
    if (rewrites.length > 0) {
      const notes = [...new Set(rewrites.map((r) => r.note))];
      // Pending edits first: a debounced save landing afterwards would undo the rewrite.
      await this.notesState.flushPending(notes);
      try {
        const report = await invoke<LinkRewriteReport>('rewrite_links', { vaultRoot, rewrites });
        logInfo(`Updated links in ${report.updated.length} notes`);
        for (const id of report.updated) if (this.notesState.getNote(id)) this.notesState.reload(id);
        locked = Math.max(locked, report.locked.length);
        await this.vaultState.refresh();
      } catch (err) {
        logError(`Failed to update links: ${formatError(err)}`);
        await this.dialogState.alert(formatError(err), { title: "Links Couldn't Be Updated", tone: 'error' });
        return;
      }
    }
    if (locked > 0) {
      await this.dialogState.alert(
        `${locked === 1 ? '1 note' : `${locked} notes`} in locked profiles couldn't be checked, so any links in them ` +
          "to what moved weren't updated.",
        { title: 'Some Links Not Checked', tone: 'warning' },
      );
    }
  }
}
