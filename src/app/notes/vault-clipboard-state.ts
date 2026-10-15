import { Injectable, signal } from '@angular/core';

/** Vault items copied or cut in the tree, waiting to be pasted into a folder. */
export interface VaultClipboardEntry {
  relPaths: string[];
  mode: 'copy' | 'cut';
}

@Injectable({ providedIn: 'root' })
export class VaultClipboardState {
  readonly entry = signal<VaultClipboardEntry | null>(null);

  /** Only notes can be copied; folders and files are moved, by cutting. */
  copy(relPaths: readonly string[]): void {
    this.entry.set({ relPaths: [...relPaths], mode: 'copy' });
  }

  cut(relPaths: readonly string[]): void {
    this.entry.set({ relPaths: [...relPaths], mode: 'cut' });
  }

  clear(): void {
    this.entry.set(null);
  }
}
