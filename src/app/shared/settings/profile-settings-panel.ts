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
import { CredentialsState } from '../../notes/credentials-state';
import { NoteEncryptionActions } from '../../notes/note-encryption-actions';
import { TabsState } from '../../notes/tabs-state';
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

  protected readonly profile = computed(() => this.credentialsState.profileById(this.profileId()));
  protected readonly notes = computed(() => this.credentialsState.membersByProfile().get(this.profileId()) ?? []);
  protected readonly unlocked = computed(() => this.credentialsState.isUnlocked(this.profileId()));
  /** An empty profile needs no key to delete — there's nothing to decrypt first. */
  protected readonly canDelete = computed(() => this.unlocked() || this.notes().length === 0);

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

  protected async deleteProfile(): Promise<void> {
    const id = this.profileId();
    const profile = this.profile();
    if (!profile || !this.canDelete()) return;

    const notes = this.notes();
    const message =
      notes.length > 0
        ? `"${profile.displayName}" has ${notes.length} note${notes.length === 1 ? '' : 's'} that will be decrypted to plaintext before the profile is deleted. This can't be undone.`
        : `"${profile.displayName}" will be permanently deleted. This can't be undone.`;

    const confirmed = await this.dialogState.confirm(message, {
      title: 'Delete Credential Profile',
      tone: 'warning',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;

    for (const note of notes) {
      // decrypt() already surfaces its own error dialog on failure.
      if (!(await this.encryptionActions.decrypt(note, { skipConfirm: true }))) return;
    }

    // SettingsModal notices the profile is gone and moves off its now-dangling entry.
    await this.credentialsState.delete(id);
  }
}
