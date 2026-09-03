import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { logError, logInfo, formatError } from '../core/logger';
import { DialogState } from '../shared/dialog/dialog-state';
import { NotesState } from './notes-state';
import { VaultState } from './vault-state';
import { VaultNoteNode, flattenEncryptedNotes } from './vault-tree.model';

/** A credential profile as reported by the backend. Never carries key material. */
export interface CredentialProfile {
  id: string;
  displayName: string;
  unlocked: boolean;
  createdAt: number;
}

/** Encrypted notes naming a profile that isn't in this vault's registry. */
export interface OrphanGroup {
  profileId: string | null;
  notes: VaultNoteNode[];
}

/** Minimum password length accepted when creating a profile. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Credential profiles for the open vault: which exist, which are unlocked, and
 * which notes belong to each.
 *
 * Membership is computed from `VaultState.tree()` rather than fetched
 * separately — the scan already reads each `.mntl.enc` header, so deriving it
 * here means the sidebar and the note tree cannot disagree, and it refreshes
 * for free whenever the vault is rescanned.
 */
@Injectable({ providedIn: 'root' })
export class CredentialsState {
  private readonly vaultState = inject(VaultState);
  private readonly notesState = inject(NotesState);
  private readonly dialogState = inject(DialogState);

  readonly profiles = signal<CredentialProfile[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly unlockedIds = computed(
    () => new Set(this.profiles().filter((p) => p.unlocked).map((p) => p.id)),
  );

  /**
   * Encrypted notes grouped by the profile id in their header, for profiles
   * this vault actually has.
   *
   * Notes naming an unregistered profile are deliberately excluded so that
   * this and `orphans` partition the encrypted notes rather than overlapping.
   */
  readonly membersByProfile = computed(() => {
    const tree = this.vaultState.tree();
    const groups = new Map<string, VaultNoteNode[]>();
    if (!tree) return groups;

    const known = new Set(this.profiles().map((p) => p.id));
    for (const note of flattenEncryptedNotes(tree)) {
      if (note.profile === null || !known.has(note.profile)) continue;
      const existing = groups.get(note.profile);
      if (existing) existing.push(note);
      else groups.set(note.profile, [note]);
    }
    return groups;
  });

  /**
   * Encrypted notes whose profile isn't in this vault's registry — copied in
   * from another vault, or left behind by a deleted profile. They can't be
   * unlocked: without the registry there's no salt and no wrapped master key
   * to work from. A `null` profileId means the header itself was unreadable.
   */
  readonly orphans = computed<OrphanGroup[]>(() => {
    const tree = this.vaultState.tree();
    if (!tree) return [];

    const known = new Set(this.profiles().map((p) => p.id));
    const groups = new Map<string | null, VaultNoteNode[]>();

    for (const note of flattenEncryptedNotes(tree)) {
      if (note.profile !== null && known.has(note.profile)) continue;
      const existing = groups.get(note.profile);
      if (existing) existing.push(note);
      else groups.set(note.profile, [note]);
    }

    return [...groups].map(([profileId, notes]) => ({ profileId, notes }));
  });

  constructor() {
    // Opening a different vault invalidates every unlocked key. The backend
    // clears them on vault switch too; this keeps the UI honest immediately.
    //
    // This is the only refresh trigger it needs. Membership is computed from
    // `tree()`, so it follows every rescan on its own, and unlock status only
    // ever changes through lock/unlock/create — each of which refreshes
    // itself. Watching `tree()` here as well would just mean an extra IPC call
    // on every external file change.
    effect(() => {
      const root = this.vaultState.rootPath();
      if (!root) {
        this.profiles.set([]);
        return;
      }
      void this.refresh();
    });
  }

  isUnlocked(profileId: string | null): boolean {
    return profileId !== null && this.unlockedIds().has(profileId);
  }

  profileById(profileId: string | null): CredentialProfile | undefined {
    if (profileId === null) return undefined;
    return this.profiles().find((p) => p.id === profileId);
  }

  /** Display name for a profile, falling back to the raw id for orphans. */
  displayNameOf(profileId: string | null): string {
    if (profileId === null) return 'Unknown';
    return this.profileById(profileId)?.displayName ?? profileId;
  }

  private notePathsFor(profileId: string): string[] {
    return (this.membersByProfile().get(profileId) ?? []).map((n) => n.relPath);
  }

  async refresh(): Promise<void> {
    const root = this.vaultState.rootPath();
    if (!root) {
      this.profiles.set([]);
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    try {
      const profiles = await invoke<CredentialProfile[]>('list_credential_profiles', {
        vaultRoot: root,
      });
      this.profiles.set(profiles);
    } catch (err) {
      logError(`Failed to load credential profiles: ${formatError(err)}`);
      this.error.set(String(err));
      this.profiles.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Lock a profile, dropping its notes' decrypted content from memory.
   *
   * Order matters: pending debounced writes still hold plaintext and still
   * need the key, so they have to be flushed *before* the key goes away.
   */
  async lock(profileId: string): Promise<void> {
    const root = this.vaultState.rootPath();
    if (!root) return;

    const paths = this.notePathsFor(profileId);
    await this.notesState.flushPending(paths);

    try {
      await invoke('lock_credential_profile', { vaultRoot: root, profileId });
    } catch (err) {
      logError(`Failed to lock profile "${profileId}": ${formatError(err)}`);
      return;
    }

    this.notesState.markLocked(paths, profileId);
    await this.refresh();
  }

  async lockAll(): Promise<void> {
    await this.notesState.flushPending();

    try {
      await invoke('lock_all_credential_profiles');
    } catch (err) {
      logError(`Failed to lock all profiles: ${formatError(err)}`);
      return;
    }

    for (const profile of this.profiles()) {
      this.notesState.markLocked(this.notePathsFor(profile.id), profile.id);
    }
    await this.refresh();
  }

  /**
   * Prompt for a password and unlock `profileId`. Resolves true if the profile
   * ends up unlocked.
   *
   * Lives here rather than in a component because both the vault tree and the
   * locked-note panel need it, and it's the one place that knows how to turn a
   * backend error back into an inline dialog message.
   */
  async promptUnlock(profileId: string | null): Promise<boolean> {
    const root = this.vaultState.rootPath();
    if (!root || profileId === null) return false;
    if (this.isUnlocked(profileId)) return true;

    const profile = this.profileById(profileId);
    if (!profile) {
      await this.dialogState.alert(
        `These notes name the credential profile "${profileId}", which doesn't exist in this vault. ` +
          `They were most likely copied in from another vault, and can't be unlocked here.`,
        { title: 'Unknown profile', tone: 'warning' },
      );
      return false;
    }

    const submitted = await this.dialogState.password(
      `Enter the password for "${profile.displayName}".`,
      { title: 'Unlock profile', confirmLabel: 'Unlock' },
      async ({ password }) => {
        try {
          await invoke('unlock_credential_profile', { vaultRoot: root, profileId, password });
          return null;
        } catch (err) {
          // Returning a message keeps the dialog open with the typed value
          // intact, so a mistyped password can just be corrected.
          return String(err);
        }
      },
    );

    if (!submitted) return false;

    logInfo(`Unlocked credential profile "${profileId}"`);
    // Re-read every note that was showing as locked.
    for (const path of this.notePathsFor(profileId)) {
      this.notesState.reload(path);
    }
    await this.refresh();
    return true;
  }

  /** Prompt for a name and password, create the profile, and unlock it. Resolves the new profile's id. */
  async promptCreate(): Promise<string | null> {
    const root = this.vaultState.rootPath();
    if (!root) return null;

    let createdId: string | null = null;

    const submitted = await this.dialogState.password(
      'Notes encrypted under this profile can only be opened with this password. ' +
        'There is no way to recover it.',
      {
        title: 'New credential profile',
        confirmLabel: 'Create',
        nameLabel: 'Profile name',
        requireConfirm: true,
      },
      async ({ name, password }) => {
        if (!name.trim()) return 'Give the profile a name.';
        if (password.length < MIN_PASSWORD_LENGTH) {
          return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
        }
        try {
          const profile = await invoke<CredentialProfile>('create_credential_profile', {
            vaultRoot: root,
            displayName: name.trim(),
            password,
          });
          createdId = profile.id;
          return null;
        } catch (err) {
          return String(err);
        }
      },
    );

    if (!submitted || createdId === null) return null;

    logInfo(`Created credential profile "${createdId}"`);
    await this.refresh();
    return createdId;
  }
}
