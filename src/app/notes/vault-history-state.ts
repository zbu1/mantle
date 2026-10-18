import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { formatError, logError } from '../core/logger';
import { DialogState } from '../shared/dialog/dialog-state';
import { VaultRootState } from './vault-root-state';

/**
 * One undoable vault action. `undo` and `redo` resolve false when the user
 * backed out (e.g. cancelled an unlock prompt), leaving the step where it
 * was; a throw means the vault no longer matches the step, which is dropped.
 */
export interface HistoryStep {
  label: string;
  undo(): Promise<unknown>;
  redo(): Promise<unknown>;
}

const MAX_STEPS = 100;

/** Deleting can be undone wherever the OS trash can be restored from: not on macOS. */
export const canUndoDelete = !/Mac/i.test(navigator.userAgent);

/**
 * Undo and redo for vault actions (create, rename, move, delete, favorite,
 * encrypt, tag edits, ...), as opposed to the editor's own text history.
 * Lives for the session and is cleared when the vault changes.
 *
 * Actions record a step after they succeed. Undo and redo usually call the
 * same recording methods, so `record` is ignored while a step is applying.
 */
@Injectable({ providedIn: 'root' })
export class VaultHistoryState {
  private readonly dialogState = inject(DialogState);
  private readonly undoStack = signal<HistoryStep[]>([]);
  private readonly redoStack = signal<HistoryStep[]>([]);
  private applying = false;

  readonly canUndo = computed(() => this.undoStack().length > 0);
  readonly canRedo = computed(() => this.redoStack().length > 0);

  constructor() {
    const root = inject(VaultRootState).path;
    effect(() => {
      root();
      untracked(() => this.clear());
    });
  }

  record(step: HistoryStep): void {
    if (this.applying) return;
    this.undoStack.update((steps) => [...steps, step].slice(-MAX_STEPS));
    this.redoStack.set([]);
  }

  clear(): void {
    this.undoStack.set([]);
    this.redoStack.set([]);
  }

  undo(): Promise<void> {
    return this.apply('undo');
  }

  redo(): Promise<void> {
    return this.apply('redo');
  }

  // ponytail: "changed outside Mantle" is detected by the backend refusing
  // (missing source, taken destination, gone from the trash), not by
  // tracking watcher events per step.
  private async apply(direction: 'undo' | 'redo'): Promise<void> {
    const [from, to] = direction === 'undo' ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
    const step = from().at(-1);
    if (!step || this.applying) return;
    this.applying = true;
    from.update((steps) => steps.slice(0, -1));
    try {
      if ((await step[direction]()) === false) from.update((steps) => [...steps, step]);
      else to.update((steps) => [...steps, step]);
    } catch (err) {
      logError(`Failed to ${direction} "${step.label}": ${formatError(err)}`);
      await this.dialogState.alert(
        `"${step.label}" couldn't be ${direction === 'undo' ? 'undone' : 'redone'}, so it was skipped: ${formatError(err)}`,
        { title: direction === 'undo' ? "Couldn't Undo" : "Couldn't Redo", tone: 'warning' },
      );
    } finally {
      this.applying = false;
    }
  }
}
