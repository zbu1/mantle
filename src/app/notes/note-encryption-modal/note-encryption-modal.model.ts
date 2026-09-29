import { ENCRYPTED_NOTE_EXTENSION } from '../new-encrypted-note/new-encrypted-note.model';
import { markdownExtensionOf } from '../vault-tree.model';

/** Extension of a plaintext note on disk. Mirrors `EXT_PLAIN` in `src-tauri/src/vault.rs`. */
export const PLAINTEXT_NOTE_EXTENSION = '.mntl';

/** What confirming the modal does to the note. */
export type EncryptionOutcome = 'encrypt' | 'move' | 'decrypt';

/**
 * Vault-relative path the note ends up at. Only encrypting and decrypting
 * change the extension; moving to another profile re-seals the file in place.
 * Mirrors what `encrypt_note_to_profile` / `decrypt_note_to_plaintext` name
 * their output.
 */
export function relPathAfter(relPath: string, outcome: EncryptionOutcome): string {
  if (outcome === 'encrypt') {
    // A Markdown file is converted as it's encrypted: `notes.md` → `notes.mntl.enc`.
    const ext = markdownExtensionOf(relPath) ?? (relPath.endsWith(PLAINTEXT_NOTE_EXTENSION) ? PLAINTEXT_NOTE_EXTENSION : null);
    if (ext) return `${relPath.slice(0, -ext.length)}${ENCRYPTED_NOTE_EXTENSION}`;
  }
  if (outcome === 'decrypt' && relPath.endsWith(ENCRYPTED_NOTE_EXTENSION)) {
    return `${relPath.slice(0, -ENCRYPTED_NOTE_EXTENSION.length)}${PLAINTEXT_NOTE_EXTENSION}`;
  }
  return relPath;
}
