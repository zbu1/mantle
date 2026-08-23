import { Injectable, signal } from '@angular/core';

/** Tracks which vault tree node (by relPath) is currently showing an inline rename input. */
@Injectable({ providedIn: 'root' })
export class VaultRenameState {
  readonly renamingPath = signal<string | null>(null);

  start(relPath: string): void {
    this.renamingPath.set(relPath);
  }

  stop(): void {
    this.renamingPath.set(null);
  }
}
