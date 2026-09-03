import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { formatError, logError, logInfo } from '../core/logger';
import { ContextMenuItem } from '../shared/context-menu/context-menu.model';
import { DialogState } from '../shared/dialog/dialog-state';
import { CredentialsState } from './credentials-state';
import { CreatedNote, VaultState } from './vault-state';
import { NotesState } from './notes-state';
import { TabsState } from './tabs-state';
import { VaultNoteNode } from './vault-tree.model';

/**
 * Most profiles a context menu will list inline before collapsing to a single
 * entry. Beyond a handful the menu stops being a shortcut and starts being a
 * wall of near-identical rows.
 */
const MAX_INLINE_PROFILES = 6;

/**
 * Encrypting, decrypting and re-homing individual notes, plus the context-menu
 * entries that trigger them.
 *
 * Shared by the sidebar's note menu and the editor toolbar's encryption
 * button, which offer the same actions.
 *
 * The profiles are listed as flat top-level items (`Encrypt with "Work"`)
 * rather than a submenu: `ContextMenu` has a single positioned surface with a
 * flat keyboard model, so nesting would mean hover-intent, arrow-key nesting
 * and two-panel hit testing — a sizeable feature orthogonal to encryption. For
 * the realistic handful of profiles, flat is also one click instead of two.
 */
@Injectable({ providedIn: 'root' })
export class NoteEncryptionActions {
  private readonly credentialsState = inject(CredentialsState);
  private readonly vaultState = inject(VaultState);
  private readonly notesState = inject(NotesState);
  private readonly tabsState = inject(TabsState);
  private readonly dialogState = inject(DialogState);

  /** Menu entries for a note, reflecting whether it's encrypted and unlocked. */
  menuItems(note: VaultNoteNode): ContextMenuItem[] {
    const profiles = this.credentialsState.profiles();
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

    if (note.encrypted) {
      const others = profiles.filter((p) => p.id !== note.profile).slice(0, MAX_INLINE_PROFILES);
      return [
        ...others.map(
          (p): ContextMenuItem => ({
            kind: 'item',
            label: `Move to "${p.displayName}"`,
            icon: 'lock',
            action: () => void this.moveToProfile(note, p.id),
          }),
        ),
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Decrypt (make plaintext)',
          icon: 'unlock',
          action: () => void this.decrypt(note),
        },
      ];
    }

    if (profiles.length === 0) {
      return [
        {
          kind: 'item',
          label: 'Encrypt…',
          icon: 'lock',
          action: () => void this.createProfileThenEncrypt(note),
        },
      ];
    }

    return [
      ...profiles.slice(0, MAX_INLINE_PROFILES).map(
        (p): ContextMenuItem => ({
          kind: 'item',
          label: `Encrypt with "${p.displayName}"`,
          icon: 'lock',
          action: () => void this.encrypt(note, p.id),
        }),
      ),
      {
        kind: 'item',
        label: 'Encrypt with a new profile…',
        icon: 'lock',
        action: () => void this.createProfileThenEncrypt(note),
      },
    ];
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

  /** Convert an unlocked encrypted note back to a plaintext `.mntl` file. */
  async decrypt(note: VaultNoteNode): Promise<void> {
    const root = this.vaultState.rootPath();
    if (!root) return;
    if (!(await this.ensureUnlocked(note))) return;

    const confirmed = await this.dialogState.confirm(
      `"${note.name}" will be stored as readable text on disk, no longer protected by ` +
        `"${this.credentialsState.displayNameOf(note.profile)}".`,
      { title: 'Decrypt note?', tone: 'warning', confirmLabel: 'Decrypt' },
    );
    if (!confirmed) return;

    await this.notesState.flushPending([note.relPath]);

    try {
      const created = await invoke<CreatedNote>('decrypt_note_to_plaintext', {
        vaultRoot: root,
        relPath: note.relPath,
      });
      this.retarget(note.relPath, created);
      logInfo(`Decrypted "${note.relPath}" to plaintext`);
      await this.vaultState.refresh();
    } catch (err) {
      logError(`Failed to decrypt "${note.relPath}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Decryption Failed', tone: 'error' });
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
   * Create a new note born encrypted in `profileId`, so its contents never
   * touch the disk as plaintext, and open it.
   *
   * Names it like the sidebar's New Note does: `Untitled`, then `Untitled 2`,
   * … until one doesn't collide.
   */
  async createEncryptedNote(profileId: string, relDir = ''): Promise<CreatedNote | null> {
    const root = this.vaultState.rootPath();
    if (!root) return null;
    if (!this.credentialsState.isUnlocked(profileId)) {
      if (!(await this.credentialsState.promptUnlock(profileId))) return null;
    }

    const base = 'Untitled';
    let lastError: unknown = null;

    for (let i = 0; i < 50; i++) {
      const name = i === 0 ? base : `${base} ${i + 1}`;
      try {
        const created = await invoke<CreatedNote>('create_encrypted_note', {
          vaultRoot: root,
          relDir,
          name,
          profileId,
        });
        await this.vaultState.refresh();
        this.tabsState.openNote({ id: created.relPath, title: created.name });
        return created;
      } catch (err) {
        // Only a name collision is worth retrying; anything else (locked
        // profile, unwritable vault) would fail identically 50 more times.
        if (!String(err).includes('already exists')) {
          lastError = err;
          break;
        }
      }
    }

    logError(`Failed to create an encrypted note: ${formatError(lastError ?? 'no free name')}`);
    await this.dialogState.alert(
      lastError ? String(lastError) : 'Could not find an unused name for the new note.',
      { title: "Couldn't Create Note", tone: 'error' },
    );
    return null;
  }

  private async createProfileThenEncrypt(note: VaultNoteNode): Promise<void> {
    const profileId = await this.credentialsState.promptCreate();
    if (profileId) await this.encrypt(note, profileId);
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
   * no longer exists.
   */
  private retarget(oldRelPath: string, created: CreatedNote): void {
    this.notesState.renameNoteId(oldRelPath, created.relPath);
    this.notesState.reload(created.relPath);
    this.tabsState.renameNoteId(oldRelPath, created.relPath, created.name);
  }
}
