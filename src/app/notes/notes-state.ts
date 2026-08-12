import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { Note } from './note.model';
import { VaultState } from './vault-state';

export type NoteEntry =
  | { status: 'loading' }
  | { status: 'loaded'; note: Note }
  | { status: 'error'; message: string };

function titleFromRelPath(relPath: string): string {
  const last = relPath.split('/').pop() ?? relPath;
  return last.replace(/\.mntl$/, '');
}

const DEBOUNCE_MS = 1000;

@Injectable({ providedIn: 'root' })
export class NotesState {
  private readonly vaultState = inject(VaultState);
  private readonly entries = signal<Record<string, NoteEntry>>({});
  private readonly pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

  entry(id: string): NoteEntry | undefined {
    return this.entries()[id];
  }

  getNote(id: string): Note | undefined {
    const entry = this.entries()[id];
    return entry?.status === 'loaded' ? entry.note : undefined;
  }

  ensureLoaded(id: string): void {
    const existing = this.entries()[id];
    if (existing) return;
    this.entries.update((entries) => ({ ...entries, [id]: { status: 'loading' } }));
    void this.load(id);
  }

  private async load(id: string): Promise<void> {
    const root = this.vaultState.rootPath();
    if (!root) {
      this.entries.update((entries) => ({ ...entries, [id]: { status: 'error', message: 'No vault open' } }));
      return;
    }
    try {
      const content = await invoke<string>('read_note', { vaultRoot: root, relPath: id });
      const note: Note = { id, title: titleFromRelPath(id), content };
      this.entries.update((entries) => ({ ...entries, [id]: { status: 'loaded', note } }));
    } catch (err) {
      this.entries.update((entries) => ({ ...entries, [id]: { status: 'error', message: String(err) } }));
    }
  }

  updateContent(id: string, content: string): void {
    this.entries.update((entries) => {
      const entry = entries[id];
      if (!entry || entry.status !== 'loaded' || entry.note.content === content) return entries;
      return { ...entries, [id]: { status: 'loaded', note: { ...entry.note, content } } };
    });
    this.scheduleFlush(id);
  }

  private scheduleFlush(id: string): void {
    const existing = this.pendingWrites.get(id);
    if (existing) clearTimeout(existing);
    this.pendingWrites.set(
      id,
      setTimeout(() => {
        this.pendingWrites.delete(id);
        void this.flush(id);
      }, DEBOUNCE_MS),
    );
  }

  private async flush(id: string): Promise<void> {
    const root = this.vaultState.rootPath();
    const entry = this.entries()[id];
    if (!root || !entry || entry.status !== 'loaded') return;
    try {
      await invoke('write_note', { vaultRoot: root, relPath: id, content: entry.note.content });
    } catch (err) {
      console.error(`Failed to save note "${id}":`, err);
    }
  }
}
