import { Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import {
  LucideChevronDown,
  LucideEllipsis,
  LucideLock,
  LucideLockOpen,
  LucidePencil,
  LucideTrash2,
} from '@lucide/angular';
import { ContextMenuState } from '../context-menu/context-menu-state';
import { DialogState } from '../dialog/dialog-state';
import { Toggle } from '../toggle/toggle';
import { SettingsRow } from './settings-row';
import { AttachmentsState } from '../../notes/attachments-state';
import { CredentialsState } from '../../notes/credentials-state';
import { NoteEncryptionActions } from '../../notes/note-encryption-actions';
import { TabsState } from '../../notes/tabs-state';
import { VaultMetaState } from '../../notes/vault-meta-state';
import { VaultState } from '../../notes/vault-state';
import { VaultNoteNode } from '../../notes/vault-tree.model';

/**
 * A single credential profile's settings: rename, lock/unlock, change its
 * password, browse and manage the notes encrypted under it, and delete it.
 *
 * Shown in `SettingsModal`'s content pane when a profile is picked from its
 * sidebar. Unlike most of that modal's cosmetic-mostly rows, every control here
 * is real. `SettingsModal` owns what happens when the profile disappears.
 */
@Component({
  selector: 'app-profile-settings-panel',
  imports: [
    SettingsRow,
    Toggle,
    LucideChevronDown,
    LucideEllipsis,
    LucideLock,
    LucideLockOpen,
    LucidePencil,
    LucideTrash2,
  ],
  templateUrl: './profile-settings-panel.html',
  host: { class: 'block' },
})
export class ProfileSettingsPanel {
  readonly profileId = input.required<string>();

  protected readonly credentialsState = inject(CredentialsState);
  private readonly encryptionActions = inject(NoteEncryptionActions);
  private readonly tabsState = inject(TabsState);
  private readonly dialogState = inject(DialogState);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly attachments = inject(AttachmentsState);
  private readonly vaultState = inject(VaultState);
  private readonly vaultMeta = inject(VaultMetaState);

  protected readonly profile = computed(() => this.credentialsState.profileById(this.profileId()));
  protected readonly notes = computed(() => this.credentialsState.membersByProfile().get(this.profileId()) ?? []);
  protected readonly unlocked = computed(() => this.credentialsState.isUnlocked(this.profileId()));
  /** The other profiles its notes could move to. */
  protected readonly otherProfiles = computed(() =>
    this.credentialsState.profiles().filter((p) => p.id !== this.profileId()),
  );

  /** Whether the delete section is open, where what happens to the profile's notes is chosen. */
  protected readonly deleting = signal(false);
  protected readonly deleteMode = signal<'decrypt' | 'move' | 'delete'>('decrypt');
  protected readonly moveTarget = signal('');
  protected readonly deleteAttachments = signal(true);
  /** Attachments sealed under this profile, looked up when the delete section opens. */
  protected readonly sealedAttachments = signal<string[]>([]);
  protected readonly working = signal(false);

  /** Decrypting or moving the notes needs to read them; deleting them doesn't. */
  protected readonly canConfirmDelete = computed(() => {
    if (this.working()) return false;
    if (this.notes().length === 0 || this.deleteMode() === 'delete') return true;
    return this.unlocked() && (this.deleteMode() === 'decrypt' || this.moveTarget() !== '');
  });

  protected readonly editingName = signal(false);
  protected readonly nameDraft = signal('');
  protected readonly advancedOpen = signal(false);

  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  constructor() {
    // The same panel instance is reused as the selected profile changes, so
    // per-profile UI state must not leak from one to the next.
    effect(() => {
      this.profileId();
      untracked(() => {
        this.editingName.set(false);
        this.advancedOpen.set(false);
        this.deleting.set(false);
      });
    });
    effect(() => {
      if (this.editingName()) this.nameInput()?.nativeElement.focus();
    });
  }

  protected startEditName(): void {
    const p = this.profile();
    if (!p) return;
    this.nameDraft.set(p.displayName);
    this.editingName.set(true);
  }

  protected cancelEditName(): void {
    this.editingName.set(false);
  }

  protected async commitEditName(): Promise<void> {
    const trimmed = this.nameDraft().trim();
    this.editingName.set(false);
    if (!trimmed) return;
    await this.credentialsState.rename(this.profileId(), trimmed);
  }

  protected async toggleLock(): Promise<void> {
    const id = this.profileId();
    if (this.unlocked()) await this.credentialsState.lock(id);
    else await this.credentialsState.promptUnlock(id);
  }

  protected async changePassword(): Promise<void> {
    if (!this.unlocked()) return;
    await this.credentialsState.promptChangePassword(this.profileId());
  }

  protected openNote(note: VaultNoteNode): void {
    if (!this.unlocked()) return;
    this.tabsState.openNote({ id: note.relPath, title: note.name });
  }

  protected onNoteMenu(event: MouseEvent, note: VaultNoteNode): void {
    if (!this.unlocked()) return;
    this.contextMenuState.open(event, this.encryptionActions.menuItems(note));
  }

  protected async openDelete(): Promise<void> {
    this.deleteMode.set(this.unlocked() || this.notes().length === 0 ? 'decrypt' : 'delete');
    this.moveTarget.set('');
    this.deleteAttachments.set(true);
    this.sealedAttachments.set([]);
    this.deleting.set(true);
    try {
      this.sealedAttachments.set(await this.attachments.ofProfile(this.profileId()));
    } catch {
      // Nothing to offer; the profile can still be deleted.
    }
  }

  /**
   * Delete the profile, first dealing with its notes as chosen: decrypt them
   * to plaintext, move them to another profile, or delete them too.
   *
   * Deleting the profile destroys the only copy of its key, so nothing sealed
   * under it can be opened again. Its notes are dealt with first for that
   * reason; its attachments, once its notes have their own copies or are gone,
   * are deleted too unless the user unticks that.
   */
  protected async confirmDeleteProfile(): Promise<void> {
    const id = this.profileId();
    const profile = this.profile();
    if (!profile || !this.canConfirmDelete()) return;
    const notes = this.notes();
    const mode = this.deleteMode();

    if (mode === 'delete' && notes.length > 0) {
      const confirmed = await this.dialogState.confirm(
        `Move ${notes.length === 1 ? 'its note' : `all ${notes.length} of its notes`} to the system trash and delete ` +
          `"${profile.displayName}"? Without the profile, nothing can open ${notes.length === 1 ? 'that note' : 'those notes'} ` +
          `again, even from the trash.`,
        { title: 'Delete Profile and Notes', tone: 'warning', confirmLabel: 'Delete Everything' },
      );
      if (!confirmed) return;
    }

    this.working.set(true);
    try {
      for (const note of notes) {
        // decrypt() and moveToProfile() surface their own error dialogs.
        if (mode === 'decrypt' && !(await this.encryptionActions.decrypt(note, { skipConfirm: true }))) return;
        if (mode === 'move' && !(await this.encryptionActions.moveToProfile(note, this.moveTarget()))) return;
        if (mode === 'delete') {
          this.tabsState.closeByNoteId(note.relPath);
          try {
            await this.vaultState.deleteNote(note.relPath);
          } catch (err) {
            await this.dialogState.alert(String(err), { title: 'Delete Failed', tone: 'error' });
            return;
          }
          this.vaultMeta.forgetNote(note.relPath);
        }
      }
      if (this.deleteAttachments()) await this.attachments.delete(this.sealedAttachments());

      // SettingsModal notices the profile is gone and moves off its now-dangling entry.
      await this.credentialsState.delete(id);
    } finally {
      this.working.set(false);
    }
  }
}
