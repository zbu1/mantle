import { ENCRYPTED_NOTE_EXTENSION } from '../new-encrypted-note/new-encrypted-note.model';

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
  if (outcome === 'encrypt' && relPath.endsWith(PLAINTEXT_NOTE_EXTENSION)) {
    return `${relPath.slice(0, -PLAINTEXT_NOTE_EXTENSION.length)}${ENCRYPTED_NOTE_EXTENSION}`;
  }
  if (outcome === 'decrypt' && relPath.endsWith(ENCRYPTED_NOTE_EXTENSION)) {
    return `${relPath.slice(0, -ENCRYPTED_NOTE_EXTENSION.length)}${PLAINTEXT_NOTE_EXTENSION}`;
  }
  return relPath;
}

/** The folder part of a vault-relative path; empty string for the vault root. */
export function dirOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash === -1 ? '' : relPath.slice(0, slash);
}

/** The filename part of a vault-relative path. */
export function fileNameOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}
