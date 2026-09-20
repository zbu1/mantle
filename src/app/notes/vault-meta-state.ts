import { Injectable, computed, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { formatError, logError } from '../core/logger';

/** One recently-opened note: its vault-relative path and when it was opened (ms since the Unix epoch). */
export interface RecentNote {
  relPath: string;
  openedAt: number;
}

/**
 * Mirror of the Rust `VaultMeta` persisted at `<vault>/.mantle/state.json`.
 * The whole object round-trips on every save (the Rust side replaces the file
 * wholesale), so this service keeps the fields it doesn't use itself
 * (favorites, order, collapsedFolders) intact rather than dropping them.
 */
export interface VaultMeta {
  version: number;
  favorites: string[];
  order: Record<string, string[]>;
  collapsedFolders: string[];
  recentNotes: RecentNote[];
}

/** How many recent notes are kept in `state.json`; the sidebar shows fewer by default. */
export const MAX_RECENT_NOTES = 20;

const SAVE_DEBOUNCE_MS = 500;

function emptyMeta(): VaultMeta {
  return { version: 1, favorites: [], order: {}, collapsedFolders: [], recentNotes: [] };
}

/** Tolerates a missing or partial payload, filling absent fields with defaults. */
function normalizeMeta(raw: unknown): VaultMeta {
  const base = emptyMeta();
  if (!raw || typeof raw !== 'object') return base;
  const meta = { ...base, ...(raw as Partial<VaultMeta>) };
  meta.recentNotes = Array.isArray(meta.recentNotes)
    ? meta.recentNotes.filter((entry) => typeof entry?.relPath === 'string' && typeof entry?.openedAt === 'number')
    : [];
  return meta;
}

/**
 * The open vault's persisted metadata (`.mantle/state.json`) — for now only the
 * recently-opened note list is wired to the UI.
 *
 * Deliberately independent of `VaultState` (which drives it via `load`/`unload`)
 * so the two services don't depend on each other. Until a load succeeds every
 * mutation is a no-op: saving would otherwise overwrite an existing file that
 * merely failed to parse with a set of defaults.
 */
@Injectable({ providedIn: 'root' })
export class VaultMetaState {
  private readonly meta = signal<VaultMeta | null>(null);
  private root: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every load/unload so a slow load for a vault we've since left is discarded. */
  private generation = 0;

  /** Recently opened notes, most recent first. Empty until the vault's metadata has loaded. */
  readonly recentNotes = computed<readonly RecentNote[]>(() => this.meta()?.recentNotes ?? []);

  /** True once the open vault's metadata has been read successfully. */
  readonly loaded = computed(() => this.meta() !== null);

  /** Loads `<vaultRoot>/.mantle/state.json`, first flushing any pending save for the previous vault. */
  async load(vaultRoot: string): Promise<void> {
    this.unload();
    const generation = this.generation;
    this.root = vaultRoot;
    try {
      const raw = await invoke<unknown>('load_vault_meta', { vaultRoot });
      if (generation !== this.generation) return;
      this.meta.set(normalizeMeta(raw));
    } catch (err) {
      if (generation !== this.generation) return;
      logError(`Failed to load vault state for "${vaultRoot}": ${formatError(err)}`);
    }
  }

  /** Forgets the current vault's metadata, flushing any pending save to it first. */
  unload(): void {
    this.flush();
    this.generation++;
    this.root = null;
    this.meta.set(null);
  }

  /** Writes any pending change immediately. */
  flush(): void {
    if (this.saveTimer === null) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const meta = this.meta();
    if (!this.root || !meta) return;
    const vaultRoot = this.root;
    void invoke('save_vault_meta', { vaultRoot, state: meta }).catch((err) => {
      logError(`Failed to save vault state for "${vaultRoot}": ${formatError(err)}`);
    });
  }

  /** Moves `relPath` to the top of the recents list, stamping it as opened now. */
  recordOpened(relPath: string, openedAt = Date.now()): void {
    this.updateRecents((recents) =>
      [{ relPath, openedAt }, ...recents.filter((entry) => entry.relPath !== relPath)].slice(0, MAX_RECENT_NOTES),
    );
  }

  /** Removes `relPath` from the recents list — a note was deleted, or the user dismissed it. */
  removeRecent(relPath: string): void {
    this.updateRecents((recents) => recents.filter((entry) => entry.relPath !== relPath));
  }

  clearRecents(): void {
    this.updateRecents(() => []);
  }

  /** Repoints a recent entry at a note's new path, keeping its position and timestamp. */
  renameRecent(oldRelPath: string, newRelPath: string): void {
    this.updateRecents((recents) => {
      if (oldRelPath === newRelPath || !recents.some((entry) => entry.relPath === oldRelPath)) return recents;
      // If the destination path was already listed, keep only the renamed entry
      // so the list never holds the same note twice.
      return recents
        .filter((entry) => entry.relPath !== newRelPath)
        .map((entry) => (entry.relPath === oldRelPath ? { ...entry, relPath: newRelPath } : entry));
    });
  }

  private updateRecents(update: (recents: RecentNote[]) => RecentNote[]): void {
    const meta = this.meta();
    if (!meta) return;
    const next = update(meta.recentNotes);
    if (next === meta.recentNotes) return;
    if (next.length === meta.recentNotes.length && next.every((entry, i) => entry === meta.recentNotes[i])) return;
    this.meta.set({ ...meta, recentNotes: next });
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }
}
