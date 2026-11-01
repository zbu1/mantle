import { Injectable, inject } from '@angular/core';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { formatError, logError, logInfo } from '../core/logger';
import { DialogState } from '../shared/dialog/dialog-state';
import { FolderPickerState } from '../shared/folder-picker/folder-picker-state';
import { NotesState } from './notes-state';
import { TabsState } from './tabs-state';
import { canUndoDelete } from './vault-history-state';
import { VaultState } from './vault-state';
import { fileNameOf } from './vault-tree.model';

/** Where an attachment reference in a note leads. Mirrors `AttachmentInfo` in `attachments.rs`. */
export interface AttachmentInfo {
  relPath: string;
  /** In Mantle's own `attachments/` folder, rather than one of the user's files elsewhere in the vault. */
  managed: boolean;
  /** The credential profile it's sealed under, or null if plaintext. */
  profile: string | null;
}

/** Mirrors `UnusedAttachments` in `attachments.rs`. */
interface UnusedAttachments {
  paths: string[];
  /** Notes being deleted that are locked, so their attachments are unknown. */
  unchecked: string[];
}

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'];
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov', 'ogv'];

/** The extension of the file at `relPath`, lowercase and without any `.enc`. */
function extOf(relPath: string): string {
  const plain = relPath.replace(/\.enc$/, '');
  return plain.includes('.') ? (plain.split('.').pop()?.toLowerCase() ?? '') : '';
}

/** Whether Mantle can show the file at `relPath` (sealed or not) as an image. */
export function isImagePath(relPath: string): boolean {
  return IMAGE_EXTENSIONS.includes(extOf(relPath));
}

/** Whether Mantle can play the file at `relPath` (sealed or not) as a video. */
export function isVideoPath(relPath: string): boolean {
  return VIDEO_EXTENSIONS.includes(extOf(relPath));
}

export function isPdfPath(relPath: string): boolean {
  return extOf(relPath) === 'pdf';
}

/**
 * The URL an attachment `src` loads from, as seen from the note at
 * `noteRelPath` (empty for a path relative to the vault root), through the
 * `mantle://` protocol (`attachments.rs`), which decrypts sealed ones.
 */
export function attachmentUrl(noteRelPath: string, src: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src; // http:, data:, …
  const query = new URLSearchParams({ note: noteRelPath, src });
  // URLSearchParams writes a space as `+`, which the protocol doesn't decode.
  return `${convertFileSrc('', 'mantle')}?${query.toString().replace(/\+/g, '%20')}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Attachments — the images notes show, and other files they link — as things
 * in their own right: where one comes from, opening it, and deleting the ones
 * nothing uses any more.
 *
 * An attachment belongs to its credential profile (or to plaintext notes): the
 * backend keeps it that way on every save, which is what lets it tell an
 * unused one apart without unlocking every profile. Only files in Mantle's
 * `attachments/` folder are ever offered for deletion; the user's own files
 * elsewhere in the vault are theirs to delete.
 */
@Injectable({ providedIn: 'root' })
export class AttachmentsState {
  private readonly vaultState = inject(VaultState);
  private readonly notesState = inject(NotesState);
  private readonly dialogState = inject(DialogState);
  private readonly folderPicker = inject(FolderPickerState);
  private readonly tabsState = inject(TabsState);

  async info(noteRelPath: string, src: string): Promise<AttachmentInfo | null> {
    const vaultRoot = this.vaultState.rootPath();
    if (!vaultRoot) return null;
    return invoke<AttachmentInfo | null>('attachment_info', { noteRelPath, src });
  }

  /** Opens the vault file a link `href` in the note `noteRelPath` leads to, in a preview tab. */
  async openLinked(noteRelPath: string, href: string): Promise<void> {
    const info = await this.info(noteRelPath, href.split('#')[0]).catch(() => null);
    if (!info) {
      await this.dialogState.alert(`"${href}" doesn't lead to a file in this vault.`, { title: "Couldn't Open Link" });
      return;
    }
    this.tabsState.openNote({ id: info.relPath, title: fileNameOf(info.relPath) });
  }

  /**
   * Lets the user save a decrypted copy of the sealed attachment `relPath`
   * somewhere outside the vault: the one way it leaves Mantle as plaintext.
   */
  async saveDecryptedCopy(relPath: string): Promise<void> {
    const vaultRoot = this.vaultState.rootPath();
    if (!vaultRoot) return;
    if (!(await this.folderPicker.approve('copyTo', 'Save Decrypted Copy', fileNameOf(relPath).replace(/\.enc$/, '')))) return;
    try {
      if (!(await invoke<boolean>('save_attachment_copy', { relPath }))) return;
      logInfo(`Saved a decrypted copy of "${relPath}"`);
    } catch (err) {
      logError(`Failed to save a decrypted copy of "${relPath}": ${formatError(err)}`);
      await this.dialogState.alert(formatError(err), { title: "Couldn't Save Copy", tone: 'error' });
    }
  }

  /** Opens a vault file in the OS's default app for it. The backend refuses sealed files. */
  async openInDefaultApp(relPath: string): Promise<void> {
    const vaultRoot = this.vaultState.rootPath();
    if (!vaultRoot) return;
    try {
      await invoke('open_vault_file', { relPath });
    } catch (err) {
      logError(`Failed to open "${relPath}": ${formatError(err)}`);
      await this.dialogState.alert(formatError(err), { title: "Couldn't Open File", tone: 'error' });
    }
  }

  /** Moves attachments to the OS trash, reporting a failure rather than throwing. */
  async delete(paths: readonly string[]): Promise<void> {
    const vaultRoot = this.vaultState.rootPath();
    if (!vaultRoot || paths.length === 0) return;
    try {
      await invoke('delete_attachments', { paths });
      logInfo(`Moved ${plural(paths.length, 'attachment')} to the trash`);
    } catch (err) {
      logError(`Failed to delete attachments: ${formatError(err)}`);
      await this.dialogState.alert(formatError(err), { title: "Couldn't Delete Attachments", tone: 'error' });
    }
  }

  /** Every attachment sealed under `profileId`, used or not. */
  async ofProfile(profileId: string): Promise<string[]> {
    const vaultRoot = this.vaultState.rootPath();
    if (!vaultRoot) return [];
    return invoke<string[]>('profile_attachments', { profileId });
  }

  /**
   * Confirm deleting the notes `relPaths`, offering to also delete the
   * attachments only they use. Resolves whether to go ahead, and the
   * attachments to delete with them (none unless the user ticked the box).
   *
   * `what` names the target in the dialog: a note's name, a folder's, or a count.
   */
  async confirmDeleteNotes(
    relPaths: readonly string[],
    what: { title: string; message: string; scope: 'note' | 'folder' | 'notes' },
  ): Promise<{ confirmed: boolean; attachments: string[] }> {
    const unused = await this.unused(relPaths, []);
    let message = what.message;
    if (unused.unchecked.length > 0) {
      const locked = unused.unchecked.length;
      message +=
        what.scope === 'note'
          ? "\n\nIt's locked, so its attachments can't be checked and will be kept."
          : `\n\n${plural(locked, 'locked note')} can't be checked for attachments; theirs will be kept.`;
    }

    const options = { title: what.title, tone: 'warning' as const, confirmLabel: 'Move to Trash' };
    const count = unused.paths.length;
    // Nothing to choose about, and the delete can be undone: no need to ask.
    if (count === 0) return { confirmed: canUndoDelete || (await this.dialogState.confirm(message, options)), attachments: [] };

    const owner = { note: 'it', folder: 'notes in this folder', notes: 'these notes' }[what.scope];
    const { confirmed, checked } = await this.dialogState.confirmWithCheckbox(message, {
      ...options,
      checkboxLabel:
        what.scope === 'note'
          ? `Also move its ${plural(count, 'attachment')} to the trash. No other note uses ${count === 1 ? 'it' : 'them'}.`
          : `Also move ${plural(count, 'attachment')} that only ${owner} use to the trash.`,
    });
    return { confirmed, attachments: confirmed && checked ? unused.paths : [] };
  }

  /**
   * After an attachment was removed from the note `noteRelPath`: if it's one
   * of Mantle's and nothing else uses it now — this note included — offer to
   * move the file to the trash too.
   */
  async offerDeleteAfterRemoval(noteRelPath: string, info: AttachmentInfo): Promise<void> {
    if (!info.managed) return;
    const { paths } = await this.unused([], [info.relPath]);
    if (!paths.includes(info.relPath)) return;
    const confirmed = await this.dialogState.confirm(
      `"${fileNameOf(info.relPath)}" isn't used by any other note. Move the file to the system trash too?`,
      { title: 'Delete Attachment File?', tone: 'warning', confirmLabel: 'Move to Trash', cancelLabel: 'Keep File' },
    );
    if (confirmed) await this.delete([info.relPath]);
  }

  /**
   * The attachments among `candidates` and those the notes `deleting`
   * reference, that no other note uses. Every pending edit is saved first —
   * one may have just added a reference — so the check sees what the user
   * sees. A failed check finds nothing to delete.
   */
  private async unused(deleting: readonly string[], candidates: readonly string[]): Promise<UnusedAttachments> {
    const vaultRoot = this.vaultState.rootPath();
    if (!vaultRoot) return { paths: [], unchecked: [] };
    await this.notesState.flushPending();
    try {
      return await invoke<UnusedAttachments>('unused_attachments', { deleting, candidates });
    } catch (err) {
      logError(`Failed to check which attachments are unused: ${formatError(err)}`);
      return { paths: [], unchecked: [] };
    }
  }
}
