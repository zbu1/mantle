import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { formatError, logError, logInfo } from '../core/logger';
import { ContextMenuFlatItem } from '../shared/context-menu/context-menu.model';
import { DialogState } from '../shared/dialog/dialog-state';
import { CredentialsState } from './credentials-state';
import { FavoritesState } from './favorites-state';
import { CreatedNote, VaultState } from './vault-state';
import { NoteEncryptionModalState } from './note-encryption-modal/note-encryption-modal-state';
import { NotesState } from './notes-state';
import { TabsState } from './tabs-state';
import { VaultActions } from './vault-actions';
import { VaultHistoryState, canUndoDelete } from './vault-history-state';
import { VaultMetaState } from './vault-meta-state';
import { VaultNoteNode, dirOf, fileNameOf, flattenAllNotes, flattenTreeNodes, markdownExtensionOf } from './vault-tree.model';

/** Mirrors `ConvertReport` in `notes_crypto.rs`. */
interface ConvertReport {
  converted: { from: string; name: string; relPath: string }[];
  failed: { relPath: string; error: string }[];
  /** Linked files that were copied in and, as nothing else used them, trashed. */
  removed: string[];
}

/** What converting a Markdown file does, behind the `?` wherever Mantle offers it. */
export const CONVERT_HELP =
  'Converting turns a plain Markdown file into a Mantle note (.mntl), saved beside it.\n\n' +
  'Why: only Mantle notes can be encrypted, and a note keeps the files it links to together with it, ' +
  "in the vault's attachments folder.\n\n" +
  'What changes: the frontmatter becomes the note\'s properties, and the files it links or embeds are ' +
  'copied into attachments. The original goes to the system trash.\n\n' +
  "What you lose: other Markdown apps (Obsidian, VS Code, …) can't open .mntl notes.";

/** A Markdown file's name without its extension: the name its note starts from. */
const stemOf = (relPath: string) => fileNameOf(relPath).replace(/\.(md|markdown)$/, '');

/**
 * Encrypting, decrypting and re-homing individual notes, converting plain
 * Markdown files into Mantle notes, plus the context-menu entries that trigger
 * them.
 *
 * Shared by the sidebar's note menu and the editor toolbar's encryption
 * button, which offer the same actions.
 *
 * The menu offers a single entry — "Encrypt…" or "Change Encryption…" — that
 * opens `NoteEncryptionModal`, where the profile (or removing encryption) is
 * chosen. That keeps the menu the same size however many profiles the vault
 * has, and gives unlocking or creating a profile somewhere to happen.
 */
@Injectable({ providedIn: 'root' })
export class NoteEncryptionActions {
  private readonly credentialsState = inject(CredentialsState);
  private readonly vaultState = inject(VaultState);
  private readonly notesState = inject(NotesState);
  private readonly tabsState = inject(TabsState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly favorites = inject(FavoritesState);
  private readonly dialogState = inject(DialogState);
  private readonly modalState = inject(NoteEncryptionModalState);
  private readonly history = inject(VaultHistoryState);
  private readonly vaultActions = inject(VaultActions);

  /** Menu entries for a note, reflecting whether it's encrypted and unlocked. */
  menuItems(note: VaultNoteNode): ContextMenuFlatItem[] {
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

    const items: ContextMenuFlatItem[] = [];
    if (markdownExtensionOf(note.relPath)) {
      items.push({ kind: 'item', label: 'Convert to Mantle Note', icon: 'convert', action: () => void this.convertToNotes([note]) });
    }
    items.push({
      kind: 'item',
      label: note.encrypted ? 'Change Encryption…' : 'Encrypt…',
      icon: 'lock',
      action: () => this.modalState.open(note),
    });
    return items;
  }

  /** The Markdown files among `relPaths`, and every one inside a folder among them at any depth. */
  markdownNotesIn(relPaths: readonly string[]): VaultNoteNode[] {
    return this.notesIn(relPaths, (note) => !!markdownExtensionOf(note.relPath));
  }

  /** The Mantle notes (`.mntl`, `.mntl.enc`) among `relPaths`, and every one inside a folder among them. */
  mantleNotesIn(relPaths: readonly string[]): VaultNoteNode[] {
    return this.notesIn(relPaths, (note) => !markdownExtensionOf(note.relPath));
  }

  private notesIn(relPaths: readonly string[], keep: (note: VaultNoteNode) => boolean): VaultNoteNode[] {
    const tree = this.vaultState.tree();
    if (!tree) return [];
    const nodes = flattenTreeNodes(tree);
    const found = new Map<string, VaultNoteNode>();
    for (const path of relPaths) {
      const node = nodes.get(path);
      const notes = node?.type === 'folder' ? flattenAllNotes(node) : node?.type === 'note' ? [node] : [];
      for (const note of notes) if (keep(note)) found.set(note.relPath, note);
    }
    return [...found.values()];
  }

  /**
   * Convert plain Markdown files into `.mntl` notes beside them, as one undo
   * step. Each file's frontmatter becomes its properties and the files it
   * links are copied into `attachments/`; the originals go to the OS trash.
   * A note name that's taken asks whether to skip that file or rename its note.
   */
  async convertToNotes(notes: readonly VaultNoteNode[]): Promise<void> {
    const root = this.vaultState.rootPath();
    const tree = this.vaultState.tree();
    if (!root || !tree || notes.length === 0) return;

    const [first] = notes;
    const { confirmed, checked: removeOriginals } = await this.dialogState.confirmWithCheckbox(
      (notes.length === 1
        ? `"${fileNameOf(first.relPath)}" will become "${first.name}.mntl". `
        : `${notes.length} Markdown files will become Mantle notes. `) +
        `Frontmatter becomes properties, and files the notes link to are copied into the attachments folder. ` +
        `Other Markdown apps won't open them any more; the originals are moved to the trash.`,
      {
        title: notes.length === 1 ? 'Convert to Mantle Note?' : `Convert ${notes.length} Files to Mantle Notes?`,
        tone: 'warning',
        confirmLabel: 'Convert',
        checkboxLabel: 'Also move the linked files no other note uses to the trash',
        help: CONVERT_HELP,
      },
    );
    if (!confirmed) return;

    const taken = new Set(flattenTreeNodes(tree).keys());
    const requests: { relPath: string; name: string }[] = [];
    for (const note of notes) {
      const dir = dirOf(note.relPath);
      const pathOf = (name: string) => (dir ? `${dir}/${name}.mntl` : `${name}.mntl`);
      let name = note.name;
      if (taken.has(pathOf(name))) {
        const choice = await this.dialogState.choose(
          `"${pathOf(name)}" already exists, so "${fileNameOf(note.relPath)}" can't be converted under its own name.`,
          { title: 'Note Already Exists', confirmLabel: 'Rename', altLabel: 'Skip', cancelLabel: 'Cancel All' },
        );
        if (choice === null) return;
        if (choice === 'alt') continue;
        let n = 2;
        while (taken.has(pathOf(`${note.name} ${n}`))) n++;
        name = `${note.name} ${n}`;
      }
      taken.add(pathOf(name));
      requests.push({ relPath: note.relPath, name });
    }

    const report = await this.convert(requests, removeOriginals);
    // Undoing restores the originals from the trash, which macOS can't do.
    if (!report || report.converted.length === 0 || !canUndoDelete) return;
    const done = report.converted;
    this.history.record({
      label: done.length === 1 ? `Convert "${done[0].name}"` : `Convert ${done.length} Notes`,
      undo: async () => {
        await this.notesState.flushPending(done.map((c) => c.relPath));
        await this.vaultActions.restore([...done.map((c) => c.from), ...report.removed]);
        for (const c of done) {
          await this.vaultState.deleteNote(c.relPath);
          this.retarget(c.relPath, { relPath: c.from, name: stemOf(c.from) });
        }
      },
      redo: async () => {
        const redone = await this.convert(
          done.map((c) => ({ relPath: c.from, name: c.name })),
          removeOriginals,
        );
        return redone !== null && redone.failed.length === 0;
      },
    });
  }

  /** Runs a conversion, following each note to its new path and reporting any failures. */
  private async convert(notes: { relPath: string; name: string }[], removeOriginals: boolean): Promise<ConvertReport | null> {
    const root = this.vaultState.rootPath();
    if (!root || notes.length === 0) return null;
    await this.notesState.flushPending(notes.map((n) => n.relPath));
    try {
      const report = await invoke<ConvertReport>('convert_markdown_notes', { vaultRoot: root, notes, removeOriginals });
      for (const c of report.converted) {
        this.retarget(c.from, c);
        logInfo(`Converted "${c.from}" to "${c.relPath}"`);
      }
      if (report.removed.length > 0) logInfo(`Moved ${report.removed.length} linked files no note uses any more to the trash`);
      await this.vaultState.refresh();
      if (report.failed.length > 0) {
        for (const f of report.failed) logError(`Failed to convert "${f.relPath}": ${f.error}`);
        await this.dialogState.alert(report.failed.map((f) => `${fileNameOf(f.relPath)}: ${f.error}`).join('\n'), {
          title: report.converted.length === 0 ? 'Conversion Failed' : `${report.failed.length} Not Converted`,
          tone: 'error',
        });
      }
      return report;
    } catch (err) {
      logError(`Failed to convert notes: ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Conversion Failed', tone: 'error' });
      return null;
    }
  }

  /** Encrypt a plaintext note into `profileId`, unlocking that profile first if needed. Resolves whether it did. */
  async encrypt(note: VaultNoteNode, profileId: string): Promise<boolean> {
    const root = this.vaultState.rootPath();
    if (!root) return false;
    if (!this.credentialsState.isUnlocked(profileId)) {
      if (!(await this.credentialsState.promptUnlock(profileId))) return false;
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
      this.history.record({
        label: `Encrypt "${note.name}"`,
        paths: [note.relPath, created.relPath],
        undo: async () => this.decrypt(this.noteAt(created.relPath), { skipConfirm: true }),
        redo: async () => this.encrypt(this.noteAt(note.relPath), profileId),
      });
      return true;
    } catch (err) {
      logError(`Failed to encrypt "${note.relPath}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Encryption Failed', tone: 'error' });
      return false;
    }
  }

  /**
   * Convert an unlocked encrypted note back to a plaintext `.mntl` file.
   *
   * `skipConfirm` is for bulk flows (e.g. deleting a profile) that already
   * confirmed once for every note involved, rather than per note. Resolves
   * whether the note ended up decrypted.
   */
  async decrypt(note: VaultNoteNode, opts?: { skipConfirm?: boolean }): Promise<boolean> {
    const root = this.vaultState.rootPath();
    if (!root) return false;
    if (!(await this.ensureUnlocked(note))) return false;

    if (!opts?.skipConfirm) {
      const confirmed = await this.dialogState.confirm(
        `"${note.name}" will be stored as readable text on disk, no longer protected by ` +
          `"${this.credentialsState.displayNameOf(note.profile)}".`,
        { title: 'Decrypt note?', tone: 'warning', confirmLabel: 'Decrypt' },
      );
      if (!confirmed) return false;
    }

    // The note goes back to plaintext beside its siblings; a hidden one may
    // find its real name taken there.
    const tree = this.vaultState.tree();
    const dir = dirOf(note.relPath);
    const pathOf = (name: string) => (dir ? `${dir}/${name}.mntl` : `${name}.mntl`);
    const taken = new Set(tree ? flattenTreeNodes(tree).keys() : []);
    let name: string | undefined;
    if (taken.has(pathOf(note.name))) {
      let n = 2;
      while (taken.has(pathOf(`${note.name} ${n}`))) n++;
      const choice = await this.dialogState.choose(
        `"${pathOf(note.name)}" already exists. Decrypt "${note.name}" as "${note.name} ${n}" instead?`,
        { title: 'Note Already Exists', confirmLabel: 'Rename', altLabel: 'Skip', cancelLabel: 'Cancel' },
      );
      if (choice !== 'confirm') return false;
      name = `${note.name} ${n}`;
    }

    await this.notesState.flushPending([note.relPath]);
    // Decrypting clears the sealed flag; a plaintext note's favorite lives in state.json.
    const wasFavorite = this.favorites.isFavorite(note.relPath);

    try {
      const created = await invoke<CreatedNote>('decrypt_note_to_plaintext', {
        vaultRoot: root,
        relPath: note.relPath,
        name,
      });
      this.retarget(note.relPath, created);
      if (wasFavorite) this.vaultMeta.addFavorites([created.relPath]);
      logInfo(`Decrypted "${note.relPath}" to plaintext`);
      await this.vaultState.refresh();
      const profileId = note.profile;
      if (profileId) {
        this.history.record({
          label: `Decrypt "${note.name}"`,
          paths: [note.relPath, created.relPath],
          undo: async () => this.encrypt(this.noteAt(created.relPath), profileId),
          redo: async () => this.decrypt(this.noteAt(note.relPath), { skipConfirm: true }),
        });
      }
      return true;
    } catch (err) {
      logError(`Failed to decrypt "${note.relPath}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Decryption Failed', tone: 'error' });
      return false;
    }
  }

  /**
   * Re-seal an encrypted note under a different profile. The filename doesn't
   * change. Resolves whether the note ended up moved.
   */
  async moveToProfile(note: VaultNoteNode, profileId: string): Promise<boolean> {
    const root = this.vaultState.rootPath();
    if (!root) return false;
    // Both profiles have to be unlocked: one to read the note, one to reseal it.
    if (!(await this.ensureUnlocked(note))) return false;
    if (!this.credentialsState.isUnlocked(profileId)) {
      if (!(await this.credentialsState.promptUnlock(profileId))) return false;
    }

    await this.notesState.flushPending([note.relPath]);

    try {
      const created = await invoke<CreatedNote>('move_note_to_profile', { vaultRoot: root, relPath: note.relPath, profileId });
      this.retarget(note.relPath, created);
      // The content is unchanged but the entry was decrypted under the old
      // profile's key, so re-read it rather than trusting what's cached.
      this.notesState.reload(created.relPath);
      logInfo(`Moved "${note.relPath}" to profile "${profileId}"`);
      await this.vaultState.refresh();
      const from = note.profile;
      if (from) {
        this.history.record({
          label: `Move "${note.name}" to Another Profile`,
          paths: [note.relPath, created.relPath],
          undo: async () => this.moveToProfile(this.noteAt(created.relPath), from),
          redo: async () => this.moveToProfile(this.noteAt(note.relPath), profileId),
        });
      }
      return true;
    } catch (err) {
      logError(`Failed to move "${note.relPath}" to "${profileId}": ${formatError(err)}`);
      await this.dialogState.alert(String(err), { title: 'Move Failed', tone: 'error' });
      return false;
    }
  }

  /**
   * Create a note named `name` that is encrypted from the moment it exists, so
   * its contents never touch the disk as plaintext.
   *
   * `profileId` must already be unlocked. Rejects with the backend's message
   * rather than showing a dialog: the caller is the New Encrypted Note modal,
   * which surfaces it inline next to the field that caused it.
   */
  async createEncryptedNote(profileId: string, relDir: string, name: string): Promise<CreatedNote> {
    const root = this.vaultState.rootPath();
    if (!root) throw new Error('No vault is open.');

    try {
      const created = await invoke<CreatedNote>('create_encrypted_note', {
        vaultRoot: root,
        relDir,
        name,
        profileId,
      });
      logInfo(`Created encrypted note "${created.relPath}" in profile "${profileId}"`);
      await this.vaultState.refresh();
      this.vaultActions.recordCreated('note', created);
      return created;
    } catch (err) {
      logError(`Failed to create an encrypted note: ${formatError(err)}`);
      throw err;
    }
  }

  /** The note at `relPath` in the current tree, for undo steps that outlive the node they began with. */
  private noteAt(relPath: string): VaultNoteNode {
    const tree = this.vaultState.tree();
    const note = tree && flattenAllNotes(tree).find((n) => n.relPath === relPath);
    if (!note) throw new Error(`"${relPath}" no longer exists`);
    return note;
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
   * no longer exists, and recents/favorites follow even if that rescan sees
   * more than this one change at once.
   */
  private retarget(oldRelPath: string, created: CreatedNote): void {
    if (oldRelPath === created.relPath) return;
    this.notesState.renameNoteId(oldRelPath, created.relPath);
    this.notesState.reload(created.relPath);
    this.tabsState.renameNoteId(oldRelPath, created.relPath, created.name);
    this.vaultMeta.renameNote(oldRelPath, created.relPath);
  }
}
