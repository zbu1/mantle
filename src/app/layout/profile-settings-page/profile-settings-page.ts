import { Component, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import {
  LucideArrowLeft,
  LucideChevronDown,
  LucideEllipsis,
  LucideLock,
  LucideLockOpen,
  LucidePencil,
  LucideTrash2,
} from '@lucide/angular';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { DialogState } from '../../shared/dialog/dialog-state';
import { SettingsRow } from '../../shared/settings/settings-row';
import { Toggle } from '../../shared/toggle/toggle';
import { CredentialsState } from '../../notes/credentials-state';
import { NoteEncryptionActions } from '../../notes/note-encryption-actions';
import { TabsState } from '../../notes/tabs-state';
import { VaultNoteNode } from '../../notes/vault-tree.model';
import { ProfileSettingsPageState } from './profile-settings-page-state';

/**
 * A single credential profile's settings: rename, lock/unlock, change its
 * password, browse and manage the notes encrypted under it, and delete it.
 *
 * A full-page overlay rather than a modal — there's a lot here, and unlike
 * `SettingsModal`'s cosmetic-mostly rows, every control on this page is real.
 * Rendered once at the layout root, driven by `ProfileSettingsPageState`
 * (see `SettingsModal`/`SettingsModalState` for the same shape).
 */
@Component({
  selector: 'app-profile-settings-page',
  imports: [
    SettingsRow,
    Toggle,
    LucideArrowLeft,
    LucideChevronDown,
    LucideEllipsis,
    LucideLock,
    LucideLockOpen,
    LucidePencil,
    LucideTrash2,
  ],
  templateUrl: './profile-settings-page.html',
})
export class ProfileSettingsPage {
  protected readonly state = inject(ProfileSettingsPageState);
  protected readonly credentialsState = inject(CredentialsState);
  private readonly encryptionActions = inject(NoteEncryptionActions);
  private readonly tabsState = inject(TabsState);
  private readonly dialogState = inject(DialogState);
  private readonly contextMenuState = inject(ContextMenuState);

  protected readonly profile = computed(() => this.credentialsState.profileById(this.state.profileId()));
  protected readonly notes = computed(() => {
    const id = this.state.profileId();
    return id ? (this.credentialsState.membersByProfile().get(id) ?? []) : [];
  });
  protected readonly unlocked = computed(() => this.credentialsState.isUnlocked(this.state.profileId()));
  /** An empty profile needs no key to delete — there's nothing to decrypt first. */
  protected readonly canDelete = computed(() => this.unlocked() || this.notes().length === 0);

  protected readonly editingName = signal(false);
  protected readonly nameDraft = signal('');
  protected readonly advancedOpen = signal(false);

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  constructor() {
    effect(() => {
      if (this.state.isOpen()) this.panel()?.nativeElement.focus();
    });
    effect(() => {
      if (this.editingName()) this.nameInput()?.nativeElement.focus();
    });
  }

  /** If the profile this page is showing disappears (deleted elsewhere), don't leave a dangling page open. */
  private readonly closeIfProfileGone = effect(() => {
    if (this.state.isOpen() && this.state.profileId() !== null && !this.profile()) {
      this.state.close();
    }
  });

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (!this.state.isOpen()) return;
    if (this.editingName()) {
      this.cancelEditName();
      return;
    }
    this.state.close();
  }

  protected formattedCreatedAt(createdAt: number): string {
    return new Date(createdAt).toLocaleString();
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
    const id = this.state.profileId();
    const trimmed = this.nameDraft().trim();
    this.editingName.set(false);
    if (!id || !trimmed) return;
    await this.credentialsState.rename(id, trimmed);
  }

  protected async toggleLock(): Promise<void> {
    const id = this.state.profileId();
    if (!id) return;
    if (this.unlocked()) await this.credentialsState.lock(id);
    else await this.credentialsState.promptUnlock(id);
  }

  protected async changePassword(): Promise<void> {
    const id = this.state.profileId();
    if (!id || !this.unlocked()) return;
    await this.credentialsState.promptChangePassword(id);
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
    const id = this.state.profileId();
    const profile = this.profile();
    if (!id || !profile || !this.canDelete()) return;

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

    await this.credentialsState.delete(id);
    this.state.close();
  }
}
