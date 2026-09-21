import { Injectable, computed, signal } from '@angular/core';

export interface NewEncryptedNoteRequest {
  /** Folder the note will be created in; empty string is the vault root. */
  relDir: string;
  /** Profile to preselect, when the entry point already implies one (a profile's own "New note"). */
  profileId: string | null;
}

/** Drives the single New Encrypted Note modal, rendered once at the layout root (see `Dialog`/`DialogState` for the same pattern). */
@Injectable({ providedIn: 'root' })
export class NewEncryptedNoteState {
  readonly request = signal<NewEncryptedNoteRequest | null>(null);
  readonly isOpen = computed(() => this.request() !== null);

  open(options: { relDir?: string; profileId?: string | null } = {}): void {
    this.request.set({ relDir: options.relDir ?? '', profileId: options.profileId ?? null });
  }

  close(): void {
    this.request.set(null);
  }
}
