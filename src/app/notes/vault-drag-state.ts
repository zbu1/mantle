import { Injectable, signal } from '@angular/core';

/**
 * Tracks the state of an in-progress note drag: how many notes are being
 * dragged, the cursor position (for the floating drag preview), and which
 * drop target (a folder's relPath, or '' for the vault root) is currently
 * under the pointer. Shared across the tree so only the deepest target under
 * the cursor highlights — an ancestor's own dragover is unreachable once a
 * descendant's handler calls stopPropagation, so without a shared source of
 * truth the ancestor's highlight would never clear while hovering a
 * descendant.
 */
@Injectable({ providedIn: 'root' })
export class VaultDragState {
  readonly draggingCount = signal(0);
  readonly draggingFolder = signal<{ relPath: string; name: string } | null>(null);
  readonly pointer = signal<{ x: number; y: number } | null>(null);
  readonly hoveredDir = signal<string | null>(null);
  readonly hoveredDirName = signal<string | null>(null);

  startDrag(count: number): void {
    this.draggingCount.set(count);
  }

  startFolderDrag(relPath: string, name: string): void {
    this.draggingFolder.set({ relPath, name });
  }

  setPointer(x: number, y: number): void {
    this.pointer.set({ x, y });
  }

  hover(destRelDir: string, destName: string): void {
    this.hoveredDir.set(destRelDir);
    this.hoveredDirName.set(destName);
  }

  clearHover(): void {
    this.hoveredDir.set(null);
    this.hoveredDirName.set(null);
  }

  /** Resets all drag state — called once the drag operation ends, dropped or not. */
  endDrag(): void {
    this.draggingCount.set(0);
    this.draggingFolder.set(null);
    this.pointer.set(null);
    this.clearHover();
  }
}
