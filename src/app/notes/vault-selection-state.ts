import { Injectable, signal } from '@angular/core';

/**
 * Tracks which items — notes, folders and files — are selected in the vault
 * explorer tree (plain click, ctrl/cmd-click, shift-click range, Ctrl+A).
 */
@Injectable({ providedIn: 'root' })
export class VaultSelectionState {
  readonly selected = signal<ReadonlySet<string>>(new Set());

  /** Range anchor for shift-click; the last item explicitly clicked (plain or ctrl/cmd). */
  private anchor: string | null = null;

  /** Replaces the selection with `relPaths` (e.g. Ctrl+A), keeping the range anchor. */
  selectAll(relPaths: readonly string[]): void {
    this.selected.set(new Set(relPaths));
  }

  isSelected(relPath: string): boolean {
    return this.selected().has(relPath);
  }

  selectOnly(relPath: string): void {
    this.selected.set(new Set([relPath]));
    this.anchor = relPath;
  }

  toggle(relPath: string): void {
    const next = new Set(this.selected());
    if (next.has(relPath)) next.delete(relPath);
    else next.add(relPath);
    this.selected.set(next);
    this.anchor = relPath;
  }

  /** Selects every path between the last anchor and `relPath` (inclusive) within `orderedPaths`. */
  selectRange(relPath: string, orderedPaths: string[]): void {
    const anchorPath = this.anchor ?? relPath;
    const from = orderedPaths.indexOf(anchorPath);
    const to = orderedPaths.indexOf(relPath);
    if (from === -1 || to === -1) {
      this.selectOnly(relPath);
      return;
    }
    const [start, end] = from <= to ? [from, to] : [to, from];
    this.selected.set(new Set(orderedPaths.slice(start, end + 1)));
  }

  /** Drops `relPath` from the selection (e.g. a note that no longer exists after a refresh). */
  remove(relPath: string): void {
    if (!this.selected().has(relPath)) return;
    const next = new Set(this.selected());
    next.delete(relPath);
    this.selected.set(next);
    if (this.anchor === relPath) this.anchor = null;
  }

  clear(): void {
    this.selected.set(new Set());
    this.anchor = null;
  }
}
