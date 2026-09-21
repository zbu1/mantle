import { Component, ElementRef, computed, inject, input, model, output, signal, viewChild } from '@angular/core';
import { LucideLock, LucideLockOpen, LucidePlus } from '@lucide/angular';
import { CredentialProfile, CredentialsState } from '../credentials-state';
import { ProfileChoice, chosenProfileId } from './profile-picker.model';

interface ProfileRow {
  profile: CredentialProfile;
  noteCount: number;
}

let nextPickerId = 0;

/**
 * The radio list of credential profiles shared by the New Encrypted Note and
 * Encrypt / Change Encryption modals: each profile with its lock state and note
 * count, an inline password field for a locked one, and an inline form that
 * creates a profile — so choosing where a note's encryption comes from never
 * needs a second dialog.
 *
 * The picker owns unlocking and creating (and their errors); the parent owns
 * what to do with the resulting `choice`. Password fields are read from
 * template refs rather than bound to signals, so a typed password lives only
 * in the DOM input and the one call that uses it (the same approach as
 * `Dialog`).
 */
@Component({
  selector: 'app-profile-picker',
  imports: [LucideLock, LucideLockOpen, LucidePlus],
  templateUrl: './profile-picker.html',
})
export class ProfilePicker {
  private readonly credentialsState = inject(CredentialsState);

  readonly choice = model<ProfileChoice>(null);
  /** True while the parent — or this picker's own unlock/create — is working; blocks double submits. Two-way so the parent's button shows it too. */
  readonly busy = model(false);
  readonly label = input('Encrypt with');
  /** A profile the note is already in: listed and tagged "Current", but not selectable. */
  readonly currentProfileId = input<string | null>(null);
  /** Adds a "No encryption" option, for notes that are already encrypted. */
  readonly allowPlaintext = input(false);
  /** Fires once an inline unlock or profile creation succeeds, so the parent can move focus on. */
  readonly profileReady = output<void>();

  protected readonly labelId = `profile-picker-${nextPickerId++}`;
  /** Error from unlocking or creating a profile, shown under the list. */
  protected readonly error = signal<string | null>(null);

  protected readonly selectedProfileId = computed(() => chosenProfileId(this.choice()));
  protected readonly creatingProfile = computed(() => this.choice()?.kind === 'new');
  protected readonly plaintextSelected = computed(() => this.choice()?.kind === 'plaintext');

  protected readonly rows = computed<ProfileRow[]>(() => {
    const members = this.credentialsState.membersByProfile();
    return this.credentialsState
      .profiles()
      .map((profile) => ({ profile, noteCount: members.get(profile.id)?.length ?? 0 }));
  });

  private readonly unlockInput = viewChild<ElementRef<HTMLInputElement>>('unlockInput');
  private readonly newNameInput = viewChild<ElementRef<HTMLInputElement>>('newNameInput');
  private readonly newPasswordInput = viewChild<ElementRef<HTMLInputElement>>('newPasswordInput');
  private readonly newConfirmInput = viewChild<ElementRef<HTMLInputElement>>('newConfirmInput');

  protected selectProfile(profileId: string): void {
    this.choice.set({ kind: 'profile', id: profileId });
    this.error.set(null);
  }

  protected startNewProfile(): void {
    this.choice.set({ kind: 'new' });
    this.error.set(null);
  }

  protected selectPlaintext(): void {
    this.choice.set({ kind: 'plaintext' });
    this.error.set(null);
  }

  protected async unlock(): Promise<void> {
    const profileId = this.selectedProfileId();
    const password = this.unlockInput()?.nativeElement.value ?? '';
    if (!profileId || this.busy()) return;
    if (!password) {
      this.error.set('Enter a password.');
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      // On failure the field keeps what was typed, so a typo can just be corrected.
      const error = await this.credentialsState.unlockWithPassword(profileId, password);
      if (error) this.error.set(error);
      else this.profileReady.emit();
    } finally {
      this.busy.set(false);
    }
  }

  protected async createProfile(): Promise<void> {
    if (this.busy()) return;
    const name = this.newNameInput()?.nativeElement.value ?? '';
    const password = this.newPasswordInput()?.nativeElement.value ?? '';

    if (!password) {
      this.error.set('Enter a password.');
      return;
    }
    if (password !== (this.newConfirmInput()?.nativeElement.value ?? '')) {
      this.error.set("Passwords don't match.");
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.credentialsState.createProfile(name, password);
      if ('error' in result) {
        this.error.set(result.error);
        return;
      }
      this.choice.set({ kind: 'profile', id: result.id });
      this.profileReady.emit();
    } finally {
      this.busy.set(false);
    }
  }
}
