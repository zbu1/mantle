import { Injectable, computed, signal } from '@angular/core';
import { VaultNoteNode } from '../vault-tree.model';

/** Drives the single Encrypt / Change Encryption modal, rendered once at the layout root (see `NewEncryptedNoteState` for the same pattern). */
@Injectable({ providedIn: 'root' })
export class NoteEncryptionModalState {
  /** The existing notes being encrypted, moved to another profile, or decrypted. */
  readonly notes = signal<readonly VaultNoteNode[]>([]);
  /** The note, when there's exactly one. */
  readonly note = computed(() => (this.notes().length === 1 ? this.notes()[0] : null));
  readonly isOpen = computed(() => this.notes().length > 0);

  open(note: VaultNoteNode): void {
    this.notes.set([note]);
  }

  openBulk(notes: readonly VaultNoteNode[]): void {
    this.notes.set(notes);
  }

  close(): void {
    this.notes.set([]);
  }
}
