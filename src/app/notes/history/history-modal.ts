import { Component, computed, effect, inject, signal } from '@angular/core';
import { formatError } from '../../core/logger';
import { NotesState } from '../notes-state';
import { formatRelativeTime } from '../relative-time';
import { HistoryState, SnapshotInfo } from './history-state';
import { lineDiff } from './line-diff';

type Item = SnapshotInfo & { path?: string };

/** The modal listing a note's snapshots with a diff against its current text, and the deleted notes that have history. */
@Component({
  selector: 'app-history-modal',
  templateUrl: './history-modal.html',
})
export class HistoryModal {
  protected readonly state = inject(HistoryState);
  private readonly notesState = inject(NotesState);

  protected readonly items = signal<Item[]>([]);
  protected readonly selected = signal<Item | null>(null);
  protected readonly snapshotText = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(false);

  protected readonly diff = computed(() => {
    const id = this.state.noteId();
    const current = id ? this.notesState.getNote(id)?.content : undefined;
    return current === undefined ? null : lineDiff(current, this.snapshotText());
  });

  constructor() {
    effect(() => {
      if (this.state.isOpen()) void this.load(this.state.noteId());
    });
  }

  private async load(id: string | null): Promise<void> {
    this.items.set([]);
    this.selected.set(null);
    this.error.set(null);
    this.loading.set(true);
    try {
      this.items.set(id ? await this.state.list(id) : await this.state.deleted());
    } catch (err) {
      this.error.set(formatError(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async select(item: Item): Promise<void> {
    this.selected.set(item);
    try {
      this.snapshotText.set(await this.state.read(item.id));
      this.error.set(null);
    } catch (err) {
      this.error.set(formatError(err));
    }
  }

  protected async restore(): Promise<void> {
    const item = this.selected();
    if (!item) return;
    try {
      const id = this.state.noteId();
      if (id) await this.state.restore(id, this.snapshotText());
      else await this.state.restoreDeleted(item.id);
      this.state.close();
    } catch (err) {
      this.error.set(formatError(err));
    }
  }

  protected age(time: number): string {
    return formatRelativeTime(time);
  }

  protected label(item: Item): string {
    return item.path ?? new Date(item.time).toLocaleString();
  }
}
