import { Injectable, computed, signal } from '@angular/core';
import { VaultNoteNode } from '../vault-tree.model';

/** Drives the single Encrypt / Change Encryption modal, rendered once at the layout root (see `NewEncryptedNoteState` for the same pattern). */
@Injectable({ providedIn: 'root' })
export class NoteEncryptionModalState {
  /** The existing note being encrypted, moved to another profile, or decrypted. */
  readonly note = signal<VaultNoteNode | null>(null);
  readonly isOpen = computed(() => this.note() !== null);

  open(note: VaultNoteNode): void {
    this.note.set(note);
  }

  close(): void {
    this.note.set(null);
  }
}
