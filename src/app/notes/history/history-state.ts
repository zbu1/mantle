import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { TabsState } from '../tabs-state';
import { VaultState } from '../vault-state';
import { NotesState } from '../notes-state';

export interface SnapshotInfo {
  id: string;
  time: number;
}

export interface DeletedNote extends SnapshotInfo {
  path: string;
}

/** Drives the history modal: one note's snapshots, or the deleted notes that still have some. */
@Injectable({ providedIn: 'root' })
export class HistoryState {
  private readonly vaultState = inject(VaultState);
  private readonly notesState = inject(NotesState);
  private readonly tabsState = inject(TabsState);

  /** The note being viewed, or null for the deleted-notes list. */
  readonly noteId = signal<string | null>(null);
  readonly isOpen = signal(false);

  openFor(noteId: string): void {
    this.noteId.set(noteId);
    this.isOpen.set(true);
  }

  openDeleted(): void {
    this.noteId.set(null);
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }

  private get root(): string {
    const root = this.vaultState.rootPath();
    if (!root) throw new Error('No vault open');
    return root;
  }

  list(noteId: string): Promise<SnapshotInfo[]> {
    return invoke('list_snapshots', { relPath: noteId });
  }

  deleted(): Promise<DeletedNote[]> {
    return invoke('list_deleted_notes');
  }

  read(id: string): Promise<string> {
    return invoke('read_snapshot', { id });
  }

  /** Saves a snapshot's text as the note's content, as a snapshot of its own so the version it replaces stays. */
  async restore(noteId: string, content: string): Promise<void> {
    await this.notesState.flushPending([noteId]);
    await invoke('close_snapshot', { relPath: noteId });
    this.notesState.updateContent(noteId, content);
    await this.notesState.flushPending([noteId]);
  }

  async restoreDeleted(id: string): Promise<void> {
    const created = await invoke<{ name: string; relPath: string }>('restore_deleted_note', { id });
    await this.vaultState.refresh();
    this.tabsState.openNote({ id: created.relPath, title: created.name });
  }
}
