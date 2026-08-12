import { Injectable, signal } from '@angular/core';
import { VaultNoteNode } from './vault-tree.model';

export interface VaultClipboardEntry {
  relPath: string;
  name: string;
  mode: 'copy' | 'cut';
}

@Injectable({ providedIn: 'root' })
export class VaultClipboardState {
  readonly entry = signal<VaultClipboardEntry | null>(null);

  copy(note: VaultNoteNode): void {
    this.entry.set({ relPath: note.relPath, name: note.name, mode: 'copy' });
  }

  cut(note: VaultNoteNode): void {
    this.entry.set({ relPath: note.relPath, name: note.name, mode: 'cut' });
  }

  clear(): void {
    this.entry.set(null);
  }
}
