import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { logError } from '../core/logger';
import { Note } from './note.model';
import { NoteProperty, sameProperties } from './properties';
import { sameTag, tagKey } from './tags';
import { VaultState } from './vault-state';

/** What the Rust `read_note` command returns. */
interface NoteDocument {
  content: string;
  tags: string[];
  properties: NoteProperty[] | null;
}

export type NoteEntry =
  | { status: 'loading' }
  | { status: 'loaded'; note: Note }
  | { status: 'locked'; profileId: string }
  | { status: 'error'; message: string };

/**
 * Prefix the Rust `read_note`/`write_note` commands use to report that a
 * note's credential profile is locked, followed by the profile id. The backend
 * is the single authority on lock state — see `vault.rs`'s `LOCKED_ERR_PREFIX`.
 */
const LOCKED_ERR_PREFIX = 'mantle:locked:';

/** The profile id in a locked-note error, or null if `err` is a different failure. */
function lockedProfileFrom(err: unknown): string | null {
  const message = String(err);
  const at = message.indexOf(LOCKED_ERR_PREFIX);
  return at === -1 ? null : message.slice(at + LOCKED_ERR_PREFIX.length).trim();
}

export function titleFromRelPath(relPath: string): string {
  const last = relPath.split('/').pop() ?? relPath;
  // `.mntl.enc` first: it's a compound extension, so stripping `.mntl` alone
  // would leave every encrypted note titled "Dream journal.mntl.enc".
  return last.replace(/\.mntl\.enc$/, '').replace(/\.(mntl|md|markdown)$/, '');
}

const DEBOUNCE_MS = 1000;

/** Attachment sources a save re-pointed, each with its new source. See `write_note`. */
export interface Relinked {
  noteId: string;
  sources: Record<string, string>;
}

@Injectable({ providedIn: 'root' })
export class NotesState {
  private readonly vaultState = inject(VaultState);
  private readonly entries = signal<Record<string, NoteEntry>>({});
  private readonly pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * The last save that re-pointed attachment links — an attachment that
   * belonged to another profile was copied to belong to this note's. The file
   * already has the new links; the open editor follows them so the next save
   * doesn't copy the attachment again.
   */
  readonly relinked = signal<Relinked | null>(null);

  constructor() {
    // Files the vault watcher saw change on disk, e.g. edited in another app.
    void listen<string[]>('notes-changed', ({ payload }) => {
      for (const id of payload) void this.refreshFromDisk(id);
    });
  }

  entry(id: string): NoteEntry | undefined {
    return this.entries()[id];
  }

  /** Every note with an entry: loaded, loading, locked or failed. */
  ids(): string[] {
    return Object.keys(this.entries());
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
      const { content, tags, properties } = await invoke<NoteDocument>('read_note', { vaultRoot: root, relPath: id });
      const note: Note = { id, title: titleFromRelPath(id), content, tags, properties };
      this.entries.update((entries) => ({ ...entries, [id]: { status: 'loaded', note } }));
    } catch (err) {
      const profileId = lockedProfileFrom(err);
      const entry: NoteEntry = profileId
        ? { status: 'locked', profileId }
        : { status: 'error', message: String(err) };
      this.entries.update((entries) => ({ ...entries, [id]: entry }));
    }
  }

  /**
   * Drop the decrypted content of `ids` and show them as locked.
   *
   * Sets the entries rather than deleting them so the locked panel appears
   * immediately, with no round trip through `read_note` just to be told what
   * we already know.
   */
  markLocked(ids: readonly string[], profileId: string): void {
    if (ids.length === 0) return;
    this.entries.update((entries) => {
      const next = { ...entries };
      for (const id of ids) {
        if (id in next) next[id] = { status: 'locked', profileId };
      }
      return next;
    });
  }

  /** Forget an entry so the next `ensureLoaded` re-fetches it — e.g. after unlocking its profile. */
  reload(id: string): void {
    this.entries.update((entries) => {
      const { [id]: _dropped, ...rest } = entries;
      return rest;
    });
    this.ensureLoaded(id);
  }

  /**
   * Re-reads a loaded note changed outside the app and updates it in place, so
   * open editors take the new text the way they take another pane's edits.
   * ponytail: a note with unsaved edits keeps them and overwrites the external
   * change on its next save; add a conflict prompt if that bites.
   */
  private async refreshFromDisk(id: string): Promise<void> {
    const root = this.vaultState.rootPath();
    if (!root || this.entries()[id]?.status !== 'loaded' || this.pendingWrites.has(id)) return;
    let doc: NoteDocument;
    try {
      doc = await invoke<NoteDocument>('read_note', { vaultRoot: root, relPath: id });
    } catch {
      return; // gone or locked; the rescan deals with it
    }
    const entry = this.entries()[id];
    if (entry?.status !== 'loaded' || this.pendingWrites.has(id)) return;
    const { note } = entry;
    const sameTags = note.tags.length === doc.tags.length && note.tags.every((tag, i) => tag === doc.tags[i]);
    if (note.content === doc.content && sameTags && sameProperties(note.properties, doc.properties)) return;
    this.entries.update((entries) => ({ ...entries, [id]: { status: 'loaded', note: { ...note, ...doc } } }));
  }

  /**
   * Write out any debounced edits now, for `ids` or for every pending note.
   *
   * Locking a profile has to await this first: a pending write still holds
   * decrypted content and still needs the key, so locking mid-debounce would
   * discard the user's last second of typing. Both the timer cancellation and
   * the write must complete before the entries are marked locked, because
   * `flush` bails on any entry that isn't `loaded`.
   */
  async flushPending(ids?: readonly string[]): Promise<void> {
    const targets = ids ?? [...this.pendingWrites.keys()];
    const writes: Promise<void>[] = [];

    for (const id of targets) {
      const timer = this.pendingWrites.get(id);
      if (!timer) continue;
      clearTimeout(timer);
      this.pendingWrites.delete(id);
      writes.push(this.flush(id));
    }

    await Promise.all(writes);
  }

  /** Re-keys an already-loaded entry after a rename, so the editor doesn't re-fetch content it already has. */
  renameNoteId(oldId: string, newId: string): void {
    if (oldId === newId) return;
    this.entries.update((entries) => {
      const entry = entries[oldId];
      if (!entry) return entries;
      const { [oldId]: _removed, ...rest } = entries;
      const migrated: NoteEntry =
        entry.status === 'loaded'
          ? { status: 'loaded', note: { ...entry.note, id: newId, title: titleFromRelPath(newId) } }
          : entry;
      return { ...rest, [newId]: migrated };
    });

    const pending = this.pendingWrites.get(oldId);
    if (pending) {
      clearTimeout(pending);
      this.pendingWrites.delete(oldId);
      this.scheduleFlush(newId);
    }
  }

  updateContent(id: string, content: string): void {
    const entry = this.entries()[id];
    // Revealing syntax in the editor changes the doc but not the Markdown; nothing to save.
    if (!entry || entry.status !== 'loaded' || entry.note.content === content) return;
    this.entries.update((entries) => ({ ...entries, [id]: { status: 'loaded', note: { ...entry.note, content } } }));
    this.scheduleFlush(id);
  }

  /** Replaces a loaded note's tags, saving them with the same debounce as its content. */
  updateTags(id: string, tags: readonly string[]): void {
    const entry = this.entries()[id];
    if (!entry || entry.status !== 'loaded') return;
    const current = entry.note.tags;
    if (current.length === tags.length && current.every((tag, i) => tag === tags[i])) return;
    this.entries.update((entries) => ({ ...entries, [id]: { status: 'loaded', note: { ...entry.note, tags: [...tags] } } }));
    this.scheduleFlush(id);
  }

  /** Replaces a loaded note's properties, saving them with the same debounce as its content. */
  updateProperties(id: string, properties: readonly NoteProperty[]): void {
    const entry = this.entries()[id];
    // Unreadable frontmatter (null) stays as it is.
    if (entry?.status !== 'loaded' || entry.note.properties === null || sameProperties(entry.note.properties, properties)) return;
    this.entries.update((entries) => ({ ...entries, [id]: { status: 'loaded', note: { ...entry.note, properties: [...properties] } } }));
    this.scheduleFlush(id);
  }

  /**
   * Mirrors a vault-wide rename (or, with `to` null, removal) of the tag
   * `from` into the loaded notes, after the backend has already rewritten the
   * files. Without this, the next save of an open note would write its old
   * tags back. Nothing is scheduled: disk already has the result.
   */
  retagLoaded(from: string, to: string | null): void {
    this.entries.update((entries) => {
      let changed = false;
      const next = { ...entries };
      for (const [id, entry] of Object.entries(entries)) {
        if (entry.status !== 'loaded' || !entry.note.tags.some((tag) => sameTag(tag, from))) continue;
        const renamed = entry.note.tags.flatMap((tag) => (sameTag(tag, from) ? (to === null ? [] : [to]) : [tag]));
        const tags = renamed.filter((tag, i) => renamed.findIndex((t) => tagKey(t) === tagKey(tag)) === i);
        next[id] = { status: 'loaded', note: { ...entry.note, tags } };
        changed = true;
      }
      return changed ? next : entries;
    });
  }

  /** Mirrors tags already written to disk (an undone tag edit) into loaded notes, without saving again. */
  setLoadedTags(tagsById: Readonly<Record<string, readonly string[]>>): void {
    this.entries.update((entries) => {
      const next = { ...entries };
      for (const [id, tags] of Object.entries(tagsById)) {
        const entry = entries[id];
        if (entry?.status === 'loaded') next[id] = { status: 'loaded', note: { ...entry.note, tags: [...tags] } };
      }
      return next;
    });
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
      const sources = await invoke<Record<string, string>>('write_note', {
        vaultRoot: root,
        relPath: id,
        content: entry.note.content,
        tags: entry.note.tags,
        properties: entry.note.properties,
      });
      if (Object.keys(sources).length > 0) this.applyRelinked(id, sources);
    } catch (err) {
      // A save can fail because the note's profile was locked while the write
      // was in flight. Either way this is unsaved user work, so it belongs in
      // the app log rather than only the browser console.
      const profileId = lockedProfileFrom(err);
      if (profileId) {
        logError(`Could not save "${id}": the "${profileId}" profile was locked before the edit was written.`);
        this.entries.update((entries) => ({ ...entries, [id]: { status: 'locked', profileId } }));
        return;
      }
      logError(`Failed to save note "${id}": ${String(err)}`);
    }
  }

  private applyRelinked(id: string, sources: Record<string, string>): void {
    this.entries.update((entries) => {
      const entry = entries[id];
      if (entry?.status !== 'loaded') return entries;
      let content = entry.note.content;
      for (const [from, to] of Object.entries(sources)) {
        content = content.split(`](${from}`).join(`](${to}`).split(`![[${from}`).join(`![[${to}`);
      }
      return { ...entries, [id]: { status: 'loaded', note: { ...entry.note, content } } };
    });
    this.relinked.set({ noteId: id, sources });
  }
}
