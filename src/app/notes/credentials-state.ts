import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { logError, logInfo, formatError } from '../core/logger';
import { DialogState } from '../shared/dialog/dialog-state';
import { NotesState } from './notes-state';
import { TabsState } from './tabs-state';
import { VaultHistoryState } from './vault-history-state';
import { VaultMetaState } from './vault-meta-state';
import { VaultState } from './vault-state';
import { VaultNoteNode, flattenEncryptedNotes } from './vault-tree.model';

/** Argon2id cost parameters, as reported by the backend. Not secret. */
export interface KdfParams {
  mCost: number;
  tCost: number;
  pCost: number;
}

/** A credential profile as reported by the backend. Never carries key material. */
export interface CredentialProfile {
  id: string;
  displayName: string;
  unlocked: boolean;
  kdf: KdfParams;
  /** Whether its notes' files sit in the vault root, their real folder sealed inside them. */
  hideLocations: boolean;
  /** Whether its notes' files get random names, their real name sealed inside them. */
  hideNames: boolean;
  /** Whether a recovery key was made for it (the key itself is never kept). */
  hasRecoveryKey: boolean;
}

/** Encrypted notes naming a profile that isn't in this vault's registry. */
export interface OrphanGroup {
  profileId: string | null;
  notes: VaultNoteNode[];
  /** Its hidden notes, which can't be listed: without the profile there's no unlocking them. */
  hiddenCount: number;
}

/** Mirrors `HidingClash` in `hidden.rs`: a note whose real path is taken, so it can't be un-hidden onto it. */
interface HidingClash {
  relPath: string;
  suggestion: string;
}

/** Mirrors `HidingReport` in `hidden.rs`. */
interface HidingReport {
  renamed: { name: string; relPath: string }[];
  renamedFrom: string[];
  failed: { relPath: string; error: string }[];
}

/** What hiding a profile's note locations and names does, behind the `?` in its settings. */
export const HIDING_HELP =
  'Hide locations: the profile\'s note files sit in the vault root instead of their folders, and each ' +
  'note\'s real folder is sealed inside it. Folders left empty are removed.\n\n' +
  'Hide names: the files get random names, and each note\'s real name is sealed inside it.\n\n' +
  'While the profile is locked its hidden notes are left out of the tree; unlocked, they show where they belong. ' +
  'Turning either on or off converts every note in the profile, so it has to be unlocked.\n\n' +
  "Old names aren't erased: hiding a note writes a new file and removes the old one, but the old name can " +
  'survive in sync history, file system journals and backups.';

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
  private readonly history = inject(VaultHistoryState);
  private readonly tabsState = inject(TabsState);
  private readonly vaultMeta = inject(VaultMetaState);

  readonly profiles = signal<CredentialProfile[]>([]);
  readonly loading = signal(false);
  /** Windows Hello: whether this device has it, and the profiles unlockable with it. */
  readonly biometric = signal<{ available: boolean; enabled: string[] }>({ available: false, enabled: [] });
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
    const hidden = this.vaultState.lockedHidden();
    for (const profileId of Object.keys(hidden)) {
      if (!known.has(profileId) && !groups.has(profileId)) groups.set(profileId, []);
    }

    return [...groups].map(([profileId, notes]) => ({
      profileId,
      notes,
      hiddenCount: profileId === null ? 0 : (hidden[profileId] ?? 0),
    }));
  });

  /** How many hidden notes `profileId` has that the tree can't list, because it's locked. */
  hiddenCountOf(profileId: string): number {
    return this.vaultState.lockedHidden()[profileId] ?? 0;
  }

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
      });
      this.profiles.set(profiles);
      this.biometric.set(await invoke<{ available: boolean; enabled: string[] }>('biometric_status').catch(() => ({ available: false, enabled: [] })));
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
      await invoke('lock_credential_profile', { profileId });
    } catch (err) {
      logError(`Failed to lock profile "${profileId}": ${formatError(err)}`);
      return;
    }

    this.notesState.markLocked(paths, profileId);
    this.forgetHidden(this.membersByProfile().get(profileId) ?? []);
    await this.refresh();
    // Rescan so the tree drops the tags it read from this profile's notes, and its hidden notes.
    await this.vaultState.refresh();
  }

  /**
   * A just-locked profile's hidden notes leave the tree, so their tabs close
   * — a locked panel would point at a path that's no longer there — and the
   * undo steps on them go.
   */
  private forgetHidden(notes: readonly VaultNoteNode[]): void {
    const hidden = notes.filter((note) => note.hidden).map((note) => note.relPath);
    for (const relPath of hidden) this.tabsState.closeByNoteId(relPath);
    this.history.dropTouching(hidden);
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
      this.forgetHidden(this.membersByProfile().get(profile.id) ?? []);
    }
    await this.refresh();
    await this.vaultState.refresh();
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
      const useKey = await this.dialogState.confirm(
        `These notes name the credential profile "${profileId}", which doesn't exist in this vault. ` +
          `They were most likely copied in from another vault. If its recovery key is at hand, it can bring the profile back.`,
        { title: 'Unknown profile', tone: 'warning', confirmLabel: 'Use Recovery Key' },
      );
      return useKey && this.promptRecover(profileId);
    }

    if (this.biometric().enabled.includes(profileId) && (await this.unlockWithBiometric(profileId)) === null) return true;

    // Returning a message from `submit` keeps the dialog open with the typed
    // value intact, so a mistyped password can just be corrected.
    return this.dialogState.password(
      `Enter the password for "${profile.displayName}".`,
      { title: 'Unlock profile', confirmLabel: 'Unlock' },
      ({ password }) => this.unlockWithPassword(profileId, password),
    );
  }

  /**
   * Unlock `profileId` with `password`. Resolves null once it's unlocked, or the
   * message to show inline if it couldn't be — the shared core of `promptUnlock`
   * and any UI that hosts its own password field.
   */
  async unlockWithPassword(profileId: string, password: string): Promise<string | null> {
    const root = this.vaultState.rootPath();
    if (!root) return 'No vault is open.';

    try {
      await invoke('unlock_credential_profile', { profileId, password });
    } catch (err) {
      return String(err);
    }

    await this.afterUnlock(profileId);
    return null;
  }

  /** Unlock `profileId` with Windows Hello. Resolves null once it's unlocked, or why it wasn't. */
  async unlockWithBiometric(profileId: string): Promise<string | null> {
    const root = this.vaultState.rootPath();
    if (!root) return 'No vault is open.';
    try {
      await invoke('unlock_with_biometric', { profileId });
    } catch (err) {
      logError(`Windows Hello unlock of "${profileId}" failed: ${formatError(err)}`);
      return String(err);
    }
    await this.afterUnlock(profileId);
    return null;
  }

  /** Turn Windows Hello unlock on or off for an unlocked profile on this device. */
  async setBiometric(profileId: string, on: boolean): Promise<void> {
    const root = this.vaultState.rootPath();
    if (!root) return;
    try {
      await invoke(on ? 'enable_biometric' : 'disable_biometric', { profileId });
    } catch (err) {
      logError(`Failed to turn Windows Hello ${on ? 'on' : 'off'} for "${profileId}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Windows Hello' });
    }
    await this.refresh();
  }

  private async afterUnlock(profileId: string): Promise<void> {
    logInfo(`Unlocked credential profile "${profileId}"`);
    // Re-read every note that was showing as locked.
    for (const path of this.notePathsFor(profileId)) {
      this.notesState.reload(path);
    }
    await this.refresh();
    // Rescan so the tree reads the tags sealed inside this profile's notes.
    await this.vaultState.refresh();
  }

  /** Prompt for a name and password, create the profile, and unlock it. Resolves the new profile's id. */
  async promptCreate(): Promise<string | null> {
    if (!this.vaultState.rootPath()) return null;

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
        const result = await this.createProfile(name, password);
        if ('error' in result) return result.error;
        createdId = result.id;
        return null;
      },
    );

    return submitted ? createdId : null;
  }

  /**
   * Create a profile and leave it unlocked. Resolves its id, or the message to
   * show inline if it couldn't be created — the shared core of `promptCreate`
   * and any UI that hosts its own name and password fields.
   */
  async createProfile(name: string, password: string): Promise<{ id: string } | { error: string }> {
    const root = this.vaultState.rootPath();
    if (!root) return { error: 'No vault is open.' };
    if (!name.trim()) return { error: 'Give the profile a name.' };
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
    }

    let profile: CredentialProfile;
    try {
      profile = await invoke<CredentialProfile>('create_credential_profile', {
        displayName: name.trim(),
        password,
      });
    } catch (err) {
      return { error: String(err) };
    }

    logInfo(`Created credential profile "${profile.id}"`);
    void this.offerRecoveryKey(profile.id);
    await this.refresh();
    const step = (command: string) => async () => {
      await invoke(command, { profileId: profile.id });
      await this.refresh();
    };
    this.history.record({
      label: `Create Profile "${profile.displayName}"`,
      undo: step('undo_create_credential_profile'),
      redo: step('redo_create_credential_profile'),
    });
    return { id: profile.id };
  }

  /** Make a recovery key and show it once. Resolves whether it was made. */
  async showRecoveryKey(profileId: string): Promise<boolean> {
    const root = this.vaultState.rootPath();
    if (!root) return false;
    let key: string;
    try {
      key = await invoke<string>('create_recovery_key', { profileId });
    } catch (err) {
      logError(`Failed to make a recovery key for "${profileId}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: "Couldn't Make Recovery Key", tone: 'error' });
      return false;
    }
    await this.refresh();
    await this.dialogState.alert(
      `${key}

Write this down or print it, and keep it somewhere safe. It is shown only once. ` +
        `With it, a forgotten password can be reset. Making a new key replaces this one.`,
      { title: 'Recovery Key', confirmLabel: 'I Saved It' },
    );
    return true;
  }

  /** A new profile's key is shown once the dialog that created it has closed. */
  private async offerRecoveryKey(profileId: string): Promise<void> {
    while (this.dialogState.request()) await new Promise((resolve) => setTimeout(resolve, 100));
    await this.showRecoveryKey(profileId);
  }

  /**
   * Ask for a recovery key, then a new password, and unlock the profile with
   * them. Also brings back a profile missing from the registry. Resolves
   * whether it ended up unlocked.
   */
  async promptRecover(profileId: string): Promise<boolean> {
    const root = this.vaultState.rootPath();
    if (!root) return false;
    const key = await this.dialogState.prompt('Enter the recovery key.', {
      title: 'Recovery Key',
      confirmLabel: 'Continue',
      placeholder: 'XXXX-XXXX-XXXX-…',
    });
    if (!key?.trim()) return false;

    const done = await this.dialogState.password(
      'Choose a new password. Existing notes stay readable.',
      { title: 'Reset Password', confirmLabel: 'Reset Password', requireConfirm: true },
      async ({ password }) => {
        if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
        try {
          await invoke('recover_credential_profile', {
            profileId,
            recoveryKey: key,
            newPassword: password,
          });
          return null;
        } catch (err) {
          return String(err);
        }
      },
    );
    if (!done) return false;

    logInfo(`Recovered credential profile "${profileId}"`);
    await this.refresh();
    for (const path of this.notePathsFor(profileId)) this.notesState.reload(path);
    await this.vaultState.refresh();
    return true;
  }

  /** Rename a profile. Works whether or not it's unlocked — renaming never touches key material. */
  async rename(profileId: string, displayName: string): Promise<boolean> {
    const root = this.vaultState.rootPath();
    const trimmed = displayName.trim();
    if (!root || !trimmed) return false;
    const before = this.profileById(profileId)?.displayName;

    try {
      await invoke('rename_credential_profile', { profileId, displayName: trimmed });
    } catch (err) {
      logError(`Failed to rename credential profile "${profileId}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Rename Failed', tone: 'error' });
      return false;
    }

    await this.refresh();
    if (before && before !== trimmed) {
      this.history.record({
        label: `Rename Profile "${before}"`,
        undo: () => this.rename(profileId, before),
        redo: () => this.rename(profileId, trimmed),
      });
    }
    return true;
  }

  /**
   * Prompt for a new password and change it. The profile must already be
   * unlocked — re-deriving a fresh KEK from a new password can't unwrap the
   * existing wrapped master key, so there's nothing to check the old
   * password against that unlocking it hasn't already proven.
   */
  async promptChangePassword(profileId: string): Promise<boolean> {
    const root = this.vaultState.rootPath();
    if (!root) return false;

    const profile = this.profileById(profileId);
    if (!profile) return false;

    const submitted = await this.dialogState.password(
      `Choose a new password for "${profile.displayName}". Existing notes stay readable. Only the password changes.`,
      { title: 'Change Master Password', confirmLabel: 'Change Password', requireConfirm: true },
      async ({ password }) => {
        if (password.length < MIN_PASSWORD_LENGTH) {
          return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
        }
        try {
          await invoke('change_credential_profile_password', {
            profileId,
            newPassword: password,
          });
          return null;
        } catch (err) {
          return String(err);
        }
      },
    );

    if (submitted) logInfo(`Changed password for credential profile "${profileId}"`);
    return submitted;
  }

  /**
   * Re-encrypt everything under a profile with a new master key, after asking
   * for its password, and show the new recovery key (the old one stops
   * working). Resolves whether it was rotated.
   */
  async promptRotateKey(profileId: string): Promise<boolean> {
    const root = this.vaultState.rootPath();
    const profile = this.profileById(profileId);
    if (!root || !profile) return false;

    let recoveryKey = '';
    const submitted = await this.dialogState.password(
      `Every note, attachment and history snapshot in "${profile.displayName}" will be re-encrypted ` +
        `under a new key. This can take a while; keep Mantle open. Enter its password to continue.`,
      { title: 'Rotate Master Key', confirmLabel: 'Rotate Key' },
      async ({ password }) => {
        try {
          // A save racing the rotation could leave a note under the old key.
          await this.notesState.flushPending(this.notePathsFor(profileId));
          recoveryKey = await invoke<string>('rotate_master_key', { profileId, password });
          return null;
        } catch (err) {
          logError(`Failed to rotate the key of "${profileId}": ${formatError(err)}`);
          return String(err);
        }
      },
    );
    if (!submitted) return false;

    logInfo(`Rotated the master key of credential profile "${profileId}"`);
    await this.refresh();
    await this.dialogState.alert(
      `${recoveryKey}

Your previous recovery key no longer works. Write this one down or print it, and keep it somewhere safe. ` +
        `It is shown only once.`,
      { title: 'New Recovery Key', confirmLabel: 'I Saved It' },
    );
    return true;
  }

  /**
   * Turn hiding note locations and/or names on or off for a profile, which
   * converts every one of its notes, as one undo step. The profile has to be
   * unlocked. Un-hiding a note whose real path is taken asks, per note,
   * whether to rename it, skip it (it stays hidden) or cancel. Resolves
   * whether the settings changed.
   */
  async setHiding(profileId: string, hideLocations: boolean, hideNames: boolean): Promise<boolean> {
    const root = this.vaultState.rootPath();
    const profile = this.profileById(profileId);
    if (!root || !profile) return false;
    if (profile.hideLocations === hideLocations && profile.hideNames === hideNames) return true;
    if (!this.isUnlocked(profileId) && !(await this.promptUnlock(profileId))) return false;
    const before = { hideLocations: profile.hideLocations, hideNames: profile.hideNames };

    // The notes are rewritten, so debounced edits go to disk first.
    await this.notesState.flushPending(this.notePathsFor(profileId));
    const renames: Record<string, string> = {};
    const skip: string[] = [];
    try {
      const clashes = await invoke<HidingClash[]>('hiding_clashes', { profileId, hideLocations, hideNames });
      for (const clash of clashes) {
        const choice = await this.dialogState.choose(
          `"${clash.relPath}" already exists, so this note can't go back there. Rename it to "${clash.suggestion}", ` +
            `or skip it and leave it hidden?`,
          { title: 'Note Already Exists', confirmLabel: 'Rename', altLabel: 'Skip', cancelLabel: 'Cancel All' },
        );
        if (choice === null) return false;
        if (choice === 'alt') skip.push(clash.relPath);
        else renames[clash.relPath] = clash.suggestion;
      }
    } catch (err) {
      await this.dialogState.alert(String(err), { title: "Couldn't Change Hidden Notes", tone: 'error' });
      return false;
    }

    let report: HidingReport;
    try {
      report = await invoke<HidingReport>('set_profile_hiding', {
        profileId,
        hideLocations,
        hideNames,
        renames,
        skip,
      });
    } catch (err) {
      logError(`Failed to change what "${profileId}" hides: ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: "Couldn't Change Hidden Notes", tone: 'error' });
      return false;
    }
    report.renamed.forEach((created, i) => {
      const from = report.renamedFrom[i];
      this.notesState.renameNoteId(from, created.relPath);
      this.tabsState.renameNoteId(from, created.relPath, created.name);
      this.vaultMeta.renameNote(from, created.relPath);
    });
    await this.refresh();
    await this.vaultState.refresh();
    if (report.failed.length > 0) {
      for (const f of report.failed) logError(`Failed to convert "${f.relPath}": ${f.error}`);
      await this.dialogState.alert(report.failed.map((f) => `${f.relPath}: ${f.error}`).join('\n'), {
        title: `${report.failed.length} Notes Not Converted`,
        tone: 'error',
      });
      // The backend reverted the settings; toggling again retries.
      return false;
    }
    logInfo(`Changed what profile "${profileId}" hides`);
    this.history.record({
      label: `Change Hidden Notes of "${profile.displayName}"`,
      undo: () => this.setHiding(profileId, before.hideLocations, before.hideNames),
      redo: () => this.setHiding(profileId, hideLocations, hideNames),
    });
    return true;
  }

  /**
   * Delete a profile's registry entry. Does not touch its notes — callers
   * that need those decrypted first (see the profile settings page's delete
   * flow) must do that before calling this.
   */
  async delete(profileId: string): Promise<void> {
    const root = this.vaultState.rootPath();
    if (!root) return;

    try {
      await invoke('delete_credential_profile', { profileId });
    } catch (err) {
      logError(`Failed to delete credential profile "${profileId}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Delete Failed', tone: 'error' });
      return;
    }

    logInfo(`Deleted credential profile "${profileId}"`);
    await this.refresh();
  }
}
