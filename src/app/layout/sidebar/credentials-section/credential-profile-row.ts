import { Component, computed, inject, input, output, signal } from '@angular/core';
import {
  LucideChevronRight,
  LucideLock,
  LucideLockOpen,
  LucidePlus,
  LucideTriangleAlert,
} from '@lucide/angular';
import { CredentialsState } from '../../../notes/credentials-state';
import { NoteEncryptionActions } from '../../../notes/note-encryption-actions';
import { VaultNoteNode } from '../../../notes/vault-tree.model';
import { SidebarItemButton } from '../sidebar-item-button/sidebar-item-button';

/**
 * One row in the Credential Profiles section: a profile's lock status, name
 * and note count, expandable to list its notes.
 *
 * Expanding and locking are deliberately separate affordances. Clicking the
 * row only expands it — if the row itself prompted for a password, simply
 * looking at which notes a profile contains would open a modal.
 */
@Component({
  selector: 'app-credential-profile-row',
  imports: [
    SidebarItemButton,
    LucideChevronRight,
    LucideLock,
    LucideLockOpen,
    LucidePlus,
    LucideTriangleAlert,
  ],
  templateUrl: './credential-profile-row.html',
  host: { class: 'block' },
})
export class CredentialProfileRow {
  /** Profile id, or null for the group of notes with an unreadable header. */
  readonly profileId = input.required<string | null>();
  readonly displayName = input.required<string>();
  readonly notes = input.required<readonly VaultNoteNode[]>();
  readonly unlocked = input(false);
  /**
   * True for notes naming a profile this vault has no record of. They can't be
   * unlocked: without the registry entry there's no salt and no wrapped master
   * key to derive from.
   */
  readonly unknown = input(false);

  readonly openNote = output<VaultNoteNode>();

  private readonly credentialsState = inject(CredentialsState);
  private readonly encryptionActions = inject(NoteEncryptionActions);

  protected readonly expanded = signal(false);
  protected readonly noteCount = computed(() => this.notes().length);

  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  protected async onLockToggle(event: MouseEvent): Promise<void> {
    // Without this the click also reaches the row and toggles expansion.
    event.stopPropagation();

    const id = this.profileId();
    if (id === null) return;

    if (this.unlocked()) await this.credentialsState.lock(id);
    else await this.credentialsState.promptUnlock(id);
  }

  protected async onNoteClick(note: VaultNoteNode): Promise<void> {
    if (this.unknown()) return;
    if (!this.unlocked() && !(await this.credentialsState.promptUnlock(this.profileId()))) return;
    this.openNote.emit(note);
  }

  /** Create a note that is encrypted from the moment it exists. */
  protected async onNewNote(): Promise<void> {
    const id = this.profileId();
    if (id === null || this.unknown()) return;
    await this.encryptionActions.createEncryptedNote(id);
  }
}
