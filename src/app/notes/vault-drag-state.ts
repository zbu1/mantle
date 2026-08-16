import { Injectable, signal } from '@angular/core';

/**
 * Tracks which drop target (a folder's relPath, or '' for the vault root) is
 * currently under the pointer during a note drag. Shared across the tree so
 * only the deepest target under the cursor highlights — an ancestor's own
 * dragover is unreachable once a descendant's handler calls
 * stopPropagation, so without a shared source of truth the ancestor's
 * highlight would never clear while hovering a descendant.
 */
@Injectable({ providedIn: 'root' })
export class VaultDragState {
  readonly hoveredDir = signal<string | null>(null);

  hover(destRelDir: string): void {
    this.hoveredDir.set(destRelDir);
  }

  clear(): void {
    this.hoveredDir.set(null);
  }
}
