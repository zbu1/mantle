import { Component, ElementRef, HostListener, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { LucideFolder, LucideLockKeyhole } from '@lucide/angular';
import { CredentialsState } from '../credentials-state';
import { CONVERT_HELP, NoteEncryptionActions } from '../note-encryption-actions';
import { HelpPopover } from '../../shared/help-popover/help-popover';
import { ProfilePicker } from '../profile-picker/profile-picker';
import { ProfileChoice, chosenProfileId } from '../profile-picker/profile-picker.model';
import { VaultState } from '../vault-state';
import { VaultNoteNode, findFolder, markdownExtensionOf } from '../vault-tree.model';
import { NoteEncryptionModalState } from './note-encryption-modal-state';
import { EncryptionOutcome, relPathAfter } from './note-encryption-modal.model';
import { dirOf, fileNameOf } from '../vault-tree.model';

/**
 * The modal behind a note's "Encrypt…" / "Change Encryption…" context-menu
 * item — rendered once at the layout root, like `NewEncryptedNote`, and built on
 * the same `ProfilePicker`.
 *
 * One dialog covers all three things you can do to an existing note: encrypt a
 * plaintext one, move an encrypted one to another profile, or (through the
 * picker's "No encryption" option) decrypt it. Which one confirming performs is
 * derived from the note and the choice (`outcome`), and the box above the
 * picker previews the file it will leave behind.
 */
@Component({
  selector: 'app-note-encryption-modal',
  imports: [HelpPopover, LucideFolder, LucideLockKeyhole, ProfilePicker],
  templateUrl: './note-encryption-modal.html',
})
export class NoteEncryptionModal {
  private readonly state = inject(NoteEncryptionModalState);
  private readonly credentialsState = inject(CredentialsState);
  private readonly vaultState = inject(VaultState);
  private readonly actions = inject(NoteEncryptionActions);

  protected readonly note = this.state.note;
  protected readonly convertHelp = CONVERT_HELP;

  protected readonly choice = signal<ProfileChoice>(null);
  /** True while the picker unlocks or creates a profile — blocks dismissal and double submits. */
  protected readonly busy = signal(false);

  protected readonly heading = computed(() => (this.note()?.encrypted ? 'Change encryption' : 'Encrypt note'));

  protected readonly status = computed(() => {
    const note = this.note();
    if (!note?.encrypted) return 'Not encrypted';
    return `Encrypted with "${this.credentialsState.displayNameOf(note.profile)}"`;
  });

  protected readonly outcome = computed<EncryptionOutcome>(() => {
    if (this.choice()?.kind === 'plaintext') return 'decrypt';
    return this.note()?.encrypted ? 'move' : 'encrypt';
  });

  protected readonly confirmLabel = computed(() => {
    if (this.busy()) return 'Working…';
    switch (this.outcome()) {
      case 'decrypt':
        return 'Decrypt note';
      case 'move':
        return 'Move note';
      case 'encrypt':
        return 'Encrypt note';
    }
  });

  protected readonly location = computed(() => dirOf(this.note()?.relPath ?? '') || 'Vault root');
  /** Where the note will be once confirmed — the extension changes when encrypting or decrypting. */
  protected readonly relPath = computed(() => {
    const note = this.note();
    return note ? relPathAfter(note.relPath, this.outcome()) : '';
  });
  protected readonly fileName = computed(() => fileNameOf(this.relPath()));

  /** The Markdown extension of the note being encrypted (e.g. `.md`), or null for a Mantle note. */
  protected readonly markdownExt = computed(() => markdownExtensionOf(this.note()?.relPath ?? ''));

  /** The profile the note is in now, by name — for the "no longer protected by" warning. */
  protected readonly currentProfileName = computed(() => this.credentialsState.displayNameOf(this.note()?.profile ?? null));

  /** True when the file this would produce is already there, e.g. `Notes.mntl.enc` beside a plaintext `Notes.mntl`. */
  private readonly collides = computed(() => {
    const note = this.note();
    const tree = this.vaultState.tree();
    const target = this.relPath();
    if (!note || !tree || target === note.relPath) return false;
    const folder = findFolder(tree, dirOf(note.relPath));
    return folder?.children.some((child) => child.type === 'note' && child.relPath === target) ?? false;
  });

  /**
   * Why the confirm button is unavailable, worded as the next thing to do, or
   * null when it's available (or merely busy, which the button label already
   * says). Ordered top to bottom as the form is laid out.
   */
  protected readonly disabledReason = computed<string | null>(() => {
    if (this.busy()) return null;
    const choice = this.choice();
    if (choice === null) {
      return this.note()?.encrypted
        ? 'Pick a profile to move this note to, or remove its encryption.'
        : 'Pick the profile to encrypt this note with.';
    }
    if (choice.kind === 'new') {
      return this.credentialsState.profiles().length === 0
        ? 'Notes are encrypted with a profile. Create one above to continue.'
        : 'Finish creating the new profile, or pick an existing one above.';
    }
    if (choice.kind === 'profile') {
      const profile = this.credentialsState.profileById(choice.id);
      if (profile && !profile.unlocked) {
        return `"${profile.displayName}" is locked. Enter its password above and press Unlock to continue.`;
      }
    }
    if (this.collides()) return `A note named "${this.fileName()}" already exists in this folder.`;
    return null;
  });

  protected readonly canConfirm = computed(() => !this.busy() && this.disabledReason() === null);

  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');

  constructor() {
    // Starting state each time the modal opens. Untracked: the picker edits
    // `choice` while it's open, and that must not reset the form.
    effect(() => {
      const note = this.note();
      if (note) untracked(() => this.reset(note));
    });

    // Move focus into the dialog so keyboard users land in it, not behind it.
    effect(() => this.dialog()?.nativeElement.focus());
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.note() && !this.busy()) this.state.close();
  }

  protected onBackdropPointerDown(event: PointerEvent): void {
    if (event.target === event.currentTarget && !this.busy()) this.state.close();
  }

  protected close(): void {
    this.state.close();
  }

  protected submit(): void {
    const note = this.note();
    const choice = this.choice();
    if (!note || !choice || !this.canConfirm()) return;

    const outcome = this.outcome();
    const profileId = chosenProfileId(choice);
    // Closed first: the actions report their own failures in an alert, which
    // shouldn't stack on top of this dialog.
    this.state.close();

    if (outcome === 'decrypt') {
      // The warning is already on screen in this dialog, so skip the second confirmation.
      void this.actions.decrypt(note, { skipConfirm: true });
    } else if (profileId) {
      void (outcome === 'move' ? this.actions.moveToProfile(note, profileId) : this.actions.encrypt(note, profileId));
    }
  }

  private reset(note: VaultNoteNode): void {
    const profiles = this.credentialsState.profiles();
    if (note.encrypted) {
      // Nothing preselected: the note's own profile can't be picked, and moving or
      // decrypting shouldn't be one Enter away.
      this.choice.set(null);
    } else {
      // Prefer an already-unlocked profile, so the common case needs no password at all.
      const preselected = profiles.find((p) => p.unlocked) ?? profiles[0];
      // No profiles at all leaves nothing to pick, so start on the form that makes one.
      this.choice.set(preselected ? { kind: 'profile', id: preselected.id } : { kind: 'new' });
    }
    this.busy.set(false);
  }
}
