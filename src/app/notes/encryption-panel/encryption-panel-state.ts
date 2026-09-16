import { Injectable, signal } from '@angular/core';
import { VaultNoteNode } from '../vault-tree.model';

export interface EncryptionPanelTarget {
  /** The toolbar button the panel is anchored under; also its toggle identity. */
  anchor: HTMLElement;
  note: VaultNoteNode;
}

/**
 * Open/closed state for the editor toolbar's encryption panel — a fixed
 * dropdown anchored under the document icon, as opposed to `ContextMenuState`
 * which positions at the mouse.
 */
@Injectable({ providedIn: 'root' })
export class EncryptionPanelState {
  readonly target = signal<EncryptionPanelTarget | null>(null);

  /** Opens the panel under `anchor`, or closes it if that anchor is already open. */
  toggle(anchor: HTMLElement, note: VaultNoteNode): void {
    this.target.update((current) => (current?.anchor === anchor ? null : { anchor, note }));
  }

  close(): void {
    this.target.set(null);
  }
}
