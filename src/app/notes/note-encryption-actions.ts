import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { formatError, logError, logInfo } from '../core/logger';
import { ContextMenuItem } from '../shared/context-menu/context-menu.model';
import { DialogState } from '../shared/dialog/dialog-state';
import { CredentialsState } from './credentials-state';
import { CreatedNote, VaultState } from './vault-state';
import { NoteEncryptionModalState } from './note-encryption-modal/note-encryption-modal-state';
import { NotesState } from './notes-state';
import { TabsState } from './tabs-state';
import { VaultMetaState } from './vault-meta-state';
import { VaultNoteNode, markdownExtensionOf } from './vault-tree.model';

/**
 * Encrypting, decrypting and re-homing individual notes, converting plain
 * Markdown files into Mantle notes, plus the context-menu entries that trigger
 * them.
 *
 * Shared by the sidebar's note menu and the editor toolbar's encryption
 * button, which offer the same actions.
 *
 * The menu offers a single entry — "Encrypt…" or "Change Encryption…" — that
 * opens `NoteEncryptionModal`, where the profile (or removing encryption) is
 * chosen. That keeps the menu the same size however many profiles the vault
 * has, and gives unlocking or creating a profile somewhere to happen.
 */
@Injectable({ providedIn: 'root' })
export class NoteEncryptionActions {
  private readonly credentialsState = inject(CredentialsState);
  private readonly vaultState = inject(VaultState);
  private readonly notesState = inject(NotesState);
  private readonly tabsState = inject(TabsState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly dialogState = inject(DialogState);
  private readonly modalState = inject(NoteEncryptionModalState);

  /** Menu entries for a note, reflecting whether it's encrypted and unlocked. */
  menuItems(note: VaultNoteNode): ContextMenuItem[] {
    const locked = note.encrypted && !this.credentialsState.isUnlocked(note.profile);

    if (note.encrypted && locked) {
      const name = this.credentialsState.displayNameOf(note.profile);
      // An orphan names a profile this vault has no record of, so there is
      // nothing to unlock it with.
      const known = note.profile !== null && this.credentialsState.profileById(note.profile);
      return [
        {
          kind: 'item',
          label: known ? `Unlock "${name}"` : 'Profile not in this vault',
          icon: 'unlock',
          disabled: !known,
          action: () => void this.credentialsState.promptUnlock(note.profile),
        },
      ];
    }

    const items: ContextMenuItem[] = [];
    if (markdownExtensionOf(note.relPath)) {
      items.push({ kind: 'item', label: 'Convert to Mantle Note', icon: 'convert', action: () => void this.convertToNote(note) });
    }
    items.push({
      kind: 'item',
      label: note.encrypted ? 'Change Encryption…' : 'Encrypt…',
      icon: 'lock',
      action: () => this.modalState.open(note),
    });
    return items;
  }

  /**
   * Convert a plain Markdown file into a `.mntl` note beside it. The file's
   * own YAML frontmatter is dropped; the original goes to the OS trash.
   */
  async convertToNote(note: VaultNoteNode): Promise<void> {
    const root = this.vaultState.rootPath();
    const ext = markdownExtensionOf(note.relPath);
    if (!root || !ext) return;

    const confirmed = await this.dialogState.confirm(
      `"${note.name}${ext}" will become "${note.name}.mntl". Other Markdown apps won't open it ` +
        `any more, and any YAML frontmatter at the top of the file will be removed. ` +
        `The original file is moved to the trash.`,
      { title: 'Convert to Mantle note?', tone: 'warning', confirmLabel: 'Convert' },
    );
    if (!confirmed) return;

    await this.notesState.flushPending([note.relPath]);

    try {
      const created = await invoke<CreatedNote>('convert_markdown_to_note', {
        vaultRoot: root,
        relPath: note.relPath,
      });
      this.retarget(note.relPath, created);
      logInfo(`Converted "${note.relPath}" to "${created.relPath}"`);
      await this.vaultState.refresh();
    } catch (err) {
      logError(`Failed to convert "${note.relPath}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Conversion Failed', tone: 'error' });
    }
  }

  /** Encrypt a plaintext note into `profileId`, unlocking that profile first if needed. */
  async encrypt(note: VaultNoteNode, profileId: string): Promise<void> {
    const root = this.vaultState.rootPath();
    if (!root) return;
    if (!this.credentialsState.isUnlocked(profileId)) {
      if (!(await this.credentialsState.promptUnlock(profileId))) return;
    }

    // The plaintext is destroyed, so make sure any debounced edit is written
    // before we encrypt what's on disk.
    await this.notesState.flushPending([note.relPath]);

    try {
      const created = await invoke<CreatedNote>('encrypt_note_to_profile', {
        vaultRoot: root,
        relPath: note.relPath,
        profileId,
      });
      this.retarget(note.relPath, created);
      logInfo(`Encrypted "${note.relPath}" into profile "${profileId}"`);
      await this.vaultState.refresh();
    } catch (err) {
      logError(`Failed to encrypt "${note.relPath}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Encryption Failed', tone: 'error' });
    }
  }

  /**
   * Convert an unlocked encrypted note back to a plaintext `.mntl` file.
   *
   * `skipConfirm` is for bulk flows (e.g. deleting a profile) that already
   * confirmed once for every note involved, rather than per note. Resolves
   * whether the note ended up decrypted.
   */
  async decrypt(note: VaultNoteNode, opts?: { skipConfirm?: boolean }): Promise<boolean> {
    const root = this.vaultState.rootPath();
    if (!root) return false;
    if (!(await this.ensureUnlocked(note))) return false;

    if (!opts?.skipConfirm) {
      const confirmed = await this.dialogState.confirm(
        `"${note.name}" will be stored as readable text on disk, no longer protected by ` +
          `"${this.credentialsState.displayNameOf(note.profile)}".`,
        { title: 'Decrypt note?', tone: 'warning', confirmLabel: 'Decrypt' },
      );
      if (!confirmed) return false;
    }

    await this.notesState.flushPending([note.relPath]);

    try {
      const created = await invoke<CreatedNote>('decrypt_note_to_plaintext', {
        vaultRoot: root,
        relPath: note.relPath,
      });
      this.retarget(note.relPath, created);
      logInfo(`Decrypted "${note.relPath}" to plaintext`);
      await this.vaultState.refresh();
      return true;
    } catch (err) {
      logError(`Failed to decrypt "${note.relPath}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Decryption Failed', tone: 'error' });
      return false;
    }
  }

  /** Re-seal an encrypted note under a different profile. The filename doesn't change. */
  async moveToProfile(note: VaultNoteNode, profileId: string): Promise<void> {
    const root = this.vaultState.rootPath();
    if (!root) return;
    // Both profiles have to be unlocked: one to read the note, one to reseal it.
    if (!(await this.ensureUnlocked(note))) return;
    if (!this.credentialsState.isUnlocked(profileId)) {
      if (!(await this.credentialsState.promptUnlock(profileId))) return;
    }

    await this.notesState.flushPending([note.relPath]);

    try {
      await invoke('move_note_to_profile', { vaultRoot: root, relPath: note.relPath, profileId });
      // The content is unchanged but the entry was decrypted under the old
      // profile's key, so re-read it rather than trusting what's cached.
      this.notesState.reload(note.relPath);
      logInfo(`Moved "${note.relPath}" to profile "${profileId}"`);
      await this.vaultState.refresh();
    } catch (err) {
      logError(`Failed to move "${note.relPath}" to "${profileId}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Move Failed', tone: 'error' });
    }
  }

  /**
   * Create a note named `name` that is encrypted from the moment it exists, so
   * its contents never touch the disk as plaintext.
   *
   * `profileId` must already be unlocked. Rejects with the backend's message
   * rather than showing a dialog: the caller is the New Encrypted Note modal,
   * which surfaces it inline next to the field that caused it.
   */
  async createEncryptedNote(profileId: string, relDir: string, name: string): Promise<CreatedNote> {
    const root = this.vaultState.rootPath();
    if (!root) throw new Error('No vault is open.');

    try {
      const created = await invoke<CreatedNote>('create_encrypted_note', {
        vaultRoot: root,
        relDir,
        name,
        profileId,
      });
      logInfo(`Created encrypted note "${created.relPath}" in profile "${profileId}"`);
      await this.vaultState.refresh();
      return created;
    } catch (err) {
      logError(`Failed to create an encrypted note: ${formatError(err)}`);
      throw err;
    }
  }

  private async ensureUnlocked(note: VaultNoteNode): Promise<boolean> {
    if (this.credentialsState.isUnlocked(note.profile)) return true;
    return this.credentialsState.promptUnlock(note.profile);
  }

  /**
   * Follow a note across the extension change from converting it.
   *
   * A rescan would eventually reach the same place via `reconcileTabs`, but
   * doing it explicitly means an open tab never briefly points at a path that
   * no longer exists, and recents/favorites follow even if that rescan sees
   * more than this one change at once.
   */
  private retarget(oldRelPath: string, created: CreatedNote): void {
    this.notesState.renameNoteId(oldRelPath, created.relPath);
    this.notesState.reload(created.relPath);
    this.tabsState.renameNoteId(oldRelPath, created.relPath, created.name);
    this.vaultMeta.renameNote(oldRelPath, created.relPath);
  }
}
