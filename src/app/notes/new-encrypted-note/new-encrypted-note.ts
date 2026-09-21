import { Component, ElementRef, HostListener, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { LucideFolder, LucideLockKeyhole } from '@lucide/angular';
import { CredentialsState } from '../credentials-state';
import { EditorFocusState } from '../editor/editor-focus-state';
import { NoteEncryptionActions } from '../note-encryption-actions';
import { ProfilePicker } from '../profile-picker/profile-picker';
import { ProfileChoice, chosenProfileId } from '../profile-picker/profile-picker.model';
import { TabsState } from '../tabs-state';
import { VaultState } from '../vault-state';
import { findFolder } from '../vault-tree.model';
import { NewEncryptedNoteRequest, NewEncryptedNoteState } from './new-encrypted-note-state';
import {
  encryptedNoteNamesIn,
  nextUntitledName,
  onDiskFileName,
  onDiskRelPath,
  validateNoteTitle,
} from './new-encrypted-note.model';

/**
 * The New Encrypted Note modal — rendered once at the layout root, like
 * `Dialog`. It's where a note's profile is chosen (through `ProfilePicker`,
 * which unlocks or creates one inline rather than through a second dialog) and
 * where the details that matter for an encrypted note are visible before it
 * exists: its title, where it will live, and what it will be called on disk.
 */
@Component({
  selector: 'app-new-encrypted-note',
  imports: [LucideFolder, LucideLockKeyhole, ProfilePicker],
  templateUrl: './new-encrypted-note.html',
})
export class NewEncryptedNote {
  protected readonly state = inject(NewEncryptedNoteState);
  private readonly credentialsState = inject(CredentialsState);
  private readonly vaultState = inject(VaultState);
  private readonly actions = inject(NoteEncryptionActions);
  private readonly tabsState = inject(TabsState);
  private readonly editorFocus = inject(EditorFocusState);

  protected readonly request = this.state.request;

  protected readonly title = signal('');
  /** The profile the note will be encrypted under, or the "new profile" form. */
  protected readonly choice = signal<ProfileChoice>(null);
  private readonly selectedProfileId = computed(() => chosenProfileId(this.choice()));
  /** True while unlocking, creating a profile or creating the note — blocks dismissal and double submits. */
  protected readonly busy = signal(false);
  /** Error from creating the note itself (e.g. a collision the tree didn't show), shown above the buttons. */
  protected readonly createError = signal<string | null>(null);

  private readonly folder = computed(() => {
    const tree = this.vaultState.tree();
    const req = this.request();
    return tree && req ? findFolder(tree, req.relDir) : null;
  });
  private readonly takenNames = computed(() => encryptedNoteNamesIn(this.folder()));

  protected readonly titleError = computed(() => validateNoteTitle(this.title(), this.takenNames()));
  protected readonly fileName = computed(() => (this.title().trim() ? onDiskFileName(this.title()) : '—'));
  protected readonly relPath = computed(() =>
    this.title().trim() ? onDiskRelPath(this.request()?.relDir ?? '', this.title()) : '—',
  );
  protected readonly location = computed(() => this.request()?.relDir || 'Vault root');

  private readonly selectedProfile = computed(() => this.credentialsState.profileById(this.selectedProfileId()));

  /**
   * Why "Create note" is unavailable, worded as the next thing to do, or null
   * when it's available (or merely busy, which the button label already says).
   * Ordered top to bottom as the form is laid out, so it names the first thing
   * the user would reach.
   */
  protected readonly disabledReason = computed<string | null>(() => {
    if (this.busy()) return null;
    if (this.titleError()) return 'Fix the title above to create the note.';
    if (this.choice()?.kind === 'new') {
      return this.credentialsState.profiles().length === 0
        ? 'Notes are encrypted with a profile. Create one above to continue.'
        : 'Finish creating the new profile, or pick an existing one above.';
    }
    const profile = this.selectedProfile();
    if (!profile) return 'Pick the profile to encrypt this note with.';
    if (!profile.unlocked) {
      return `"${profile.displayName}" is locked. Enter its password above and press Unlock to create the note.`;
    }
    return null;
  });

  protected readonly canCreate = computed(() => !this.busy() && this.disabledReason() === null);

  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');

  constructor() {
    // Starting state each time the modal opens. Untracked: the fields below
    // are edited while it's open, and editing them must not reset the form.
    effect(() => {
      const req = this.request();
      if (req) untracked(() => this.reset(req));
    });

    // Title first, selected so typing replaces the suggested name.
    effect(() => {
      const el = this.titleInput()?.nativeElement;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.request() && !this.busy()) this.state.close();
  }

  protected onBackdropPointerDown(event: PointerEvent): void {
    if (event.target === event.currentTarget && !this.busy()) this.state.close();
  }

  protected focusTitle(): void {
    this.titleInput()?.nativeElement.focus();
  }

  protected async submit(): Promise<void> {
    const req = this.request();
    const profileId = this.selectedProfileId();
    if (!req || !profileId || !this.canCreate()) return;

    this.busy.set(true);
    this.createError.set(null);
    try {
      const created = await this.actions.createEncryptedNote(profileId, req.relDir, this.title().trim());
      this.state.close();
      this.editorFocus.request(created.relPath);
      this.tabsState.openNote({ id: created.relPath, title: created.name });
    } catch (err) {
      this.createError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  private reset(req: NewEncryptedNoteRequest): void {
    const profiles = this.credentialsState.profiles();
    // A profile row's own "New note" names its profile; otherwise prefer one
    // that's already unlocked, so the common case needs no password at all.
    const preselected =
      profiles.find((p) => p.id === req.profileId) ?? profiles.find((p) => p.unlocked) ?? profiles[0];

    this.title.set(nextUntitledName(this.takenNames()));
    // No profiles at all leaves nothing to pick, so start on the form that makes one.
    this.choice.set(preselected ? { kind: 'profile', id: preselected.id } : { kind: 'new' });
    this.createError.set(null);
    this.busy.set(false);
  }
}
