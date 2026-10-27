import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { formatError, logError } from '../core/logger';
import { VaultHistoryState } from './vault-history-state';
import { PROPERTY_TYPES, PropertyType, propertyTypeKey } from './properties';
import { SORT_MODES, SortMode } from './vault-tree.model';

/** One recently-opened note: its vault-relative path and when it was opened (ms since the Unix epoch). */
export interface RecentNote {
  relPath: string;
  openedAt: number;
}

/**
 * Mirror of the Rust `VaultMeta` persisted at `<vault>/.mantle/state.json`.
 * The whole object round-trips on every save (the Rust side replaces the file
 * wholesale), so this service keeps the fields it doesn't change itself
 * (order) intact rather than dropping them.
 */
export interface VaultMeta {
  version: number;
  favorites: string[];
  order: Record<string, string[]>;
  collapsedFolders: string[];
  sortMode: SortMode;
  /** Folders sorted their own way, by relPath. */
  folderSort: Record<string, SortMode>;
  recentNotes: RecentNote[];
  /** Each property's vault-wide type, by `propertyTypeKey`. */
  propertyTypes: Record<string, PropertyType>;
}

/** How many recent notes are kept in `state.json`; the sidebar shows fewer by default. */
export const MAX_RECENT_NOTES = 20;

const SAVE_DEBOUNCE_MS = 500;

function emptyMeta(): VaultMeta {
  return { version: 1, favorites: [], order: {}, collapsedFolders: [], sortMode: 'name-asc', folderSort: {}, recentNotes: [], propertyTypes: {} };
}

/** Tolerates a missing or partial payload, filling absent fields with defaults. */
function normalizeMeta(raw: unknown): VaultMeta {
  const base = emptyMeta();
  if (!raw || typeof raw !== 'object') return base;
  const meta = { ...base, ...(raw as Partial<VaultMeta>) };
  meta.favorites = Array.isArray(meta.favorites)
    ? [...new Set(meta.favorites.filter((relPath) => typeof relPath === 'string'))]
    : [];
  meta.recentNotes = Array.isArray(meta.recentNotes)
    ? meta.recentNotes.filter((entry) => typeof entry?.relPath === 'string' && typeof entry?.openedAt === 'number')
    : [];
  meta.collapsedFolders = Array.isArray(meta.collapsedFolders)
    ? meta.collapsedFolders.filter((relPath) => typeof relPath === 'string')
    : [];
  // A type from a newer build is dropped, so the property infers one instead.
  meta.propertyTypes = Object.fromEntries(
    Object.entries(meta.propertyTypes && typeof meta.propertyTypes === 'object' ? meta.propertyTypes : {}).filter(([, type]) =>
      PROPERTY_TYPES.some((known) => known.id === type),
    ),
  );
  // A mode from a newer build falls back rather than sorting nonsensically.
  if (!SORT_MODES.some((mode) => mode.id === meta.sortMode)) meta.sortMode = 'name-asc';
  meta.folderSort = Object.fromEntries(
    Object.entries(meta.folderSort && typeof meta.folderSort === 'object' ? meta.folderSort : {}).filter(([, mode]) =>
      SORT_MODES.some((known) => known.id === mode),
    ),
  );
  return meta;
}

/**
 * The open vault's persisted metadata (`.mantle/state.json`) — for now the
 * recently-opened note list and favorites are wired to the UI.
 *
 * Favorites deliberately outlive their note disappearing from a scan: a file
 * that vanishes outside the app (e.g. mid-sync) keeps its entry, hidden, so it
 * comes back if the file does. Only an in-app delete (`forgetNote`) drops it.
 *
 * Deliberately independent of `VaultState` (which drives it via `load`/`unload`)
 * so the two services don't depend on each other. Until a load succeeds every
 * mutation is a no-op: saving would otherwise overwrite an existing file that
 * merely failed to parse with a set of defaults.
 */
@Injectable({ providedIn: 'root' })
export class VaultMetaState {
  private readonly history = inject(VaultHistoryState);
  private readonly meta = signal<VaultMeta | null>(null);
  private root: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every load/unload so a slow load for a vault we've since left is discarded. */
  private generation = 0;

  /** Recently opened notes, most recent first. Empty until the vault's metadata has loaded. */
  readonly recentNotes = computed<readonly RecentNote[]>(() => this.meta()?.recentNotes ?? []);

  /** Favorited note relPaths in display order. Empty until the vault's metadata has loaded. */
  readonly favorites = computed<readonly string[]>(() => this.meta()?.favorites ?? []);

  private readonly favoriteSet = computed<ReadonlySet<string>>(() => new Set(this.favorites()));

  /** How the vault tree sorts. */
  readonly sortMode = computed<SortMode>(() => this.meta()?.sortMode ?? 'name-asc');

  /** Folders sorted their own way rather than by `sortMode`, by relPath. */
  readonly folderSort = computed<Readonly<Record<string, SortMode>>>(() => this.meta()?.folderSort ?? {});

  /** Manual child order per folder, for the `manual` sort mode. */
  readonly order = computed<Readonly<Record<string, readonly string[]>>>(() => this.meta()?.order ?? {});

  /** Hidden notes and virtual folders, which are never written here; see `setHiddenPaths`. */
  private readonly hiddenPaths = signal<ReadonlySet<string>>(new Set());
  /** Virtual folders collapsed this session: they can't be recorded, so they start expanded. */
  private readonly sessionCollapsed = signal<ReadonlySet<string>>(new Set());

  /** Folders collapsed in the vault tree; every other folder shows open. */
  readonly collapsedFolders = computed<ReadonlySet<string>>(
    () => new Set([...(this.meta()?.collapsedFolders ?? []), ...this.sessionCollapsed()]),
  );

  /**
   * Sets which paths are hidden notes or virtual folders, as the latest scan
   * found them, and drops any that made it into recents or favorites — say,
   * a note that was followed to its new path as it became hidden.
   */
  setHiddenPaths(paths: ReadonlySet<string>): void {
    this.hiddenPaths.set(paths);
    this.sessionCollapsed.update((folders) => new Set([...folders].filter((path) => paths.has(path))));
    this.updateList('recentNotes', (recents) => recents.filter((entry) => !paths.has(entry.relPath)));
    this.updateList('favorites', (favorites) => favorites.filter((relPath) => !paths.has(relPath)));
    this.updateList('collapsedFolders', (folders) => folders.filter((relPath) => !paths.has(relPath)));
  }

  /** The vault-wide type of the property `name`, if it has been given one. */
  propertyType(name: string): PropertyType | undefined {
    return this.meta()?.propertyTypes[propertyTypeKey(name)];
  }

  /** Makes `name` a `type` in every note. Not an undo step of its own: it comes with a property edit, which is. */
  setPropertyType(name: string, type: PropertyType): void {
    const meta = this.meta();
    const key = propertyTypeKey(name);
    if (!meta || meta.propertyTypes[key] === type) return;
    this.meta.set({ ...meta, propertyTypes: { ...meta.propertyTypes, [key]: type } });
    this.scheduleSave();
  }

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
    if (this.hiddenPaths().has(relPath)) return;
    this.updateList('recentNotes', (recents) =>
      [{ relPath, openedAt }, ...recents.filter((entry) => entry.relPath !== relPath)].slice(0, MAX_RECENT_NOTES),
    );
  }

  /** Removes `relPath` from the recents list — a note was deleted, or the user dismissed it. */
  removeRecent(relPath: string): void {
    this.updateList('recentNotes', (recents) => recents.filter((entry) => entry.relPath !== relPath));
  }

  clearRecents(): void {
    this.updateList('recentNotes', () => []);
  }

  /** Repoints a recent entry at a note's new path, keeping its position and timestamp. */
  renameRecent(oldRelPath: string, newRelPath: string): void {
    this.updateList('recentNotes', (recents) => {
      if (oldRelPath === newRelPath || !recents.some((entry) => entry.relPath === oldRelPath)) return recents;
      // If the destination path was already listed, keep only the renamed entry
      // so the list never holds the same note twice.
      return recents
        .filter((entry) => entry.relPath !== newRelPath)
        .map((entry) => (entry.relPath === oldRelPath ? { ...entry, relPath: newRelPath } : entry));
    });
  }

  isFavorite(relPath: string): boolean {
    return this.favoriteSet().has(relPath);
  }

  toggleFavorite(relPath: string): void {
    if (this.isFavorite(relPath)) this.removeFavorites([relPath]);
    else this.addFavorites([relPath]);
  }

  /** Appends whichever of `relPaths` aren't favorites yet, in the given order. */
  addFavorites(relPaths: readonly string[]): void {
    this.updateList('favorites', (favorites) => {
      const current = new Set(favorites);
      return [...favorites, ...new Set(relPaths.filter((relPath) => !current.has(relPath)))];
    });
  }

  /** Replaces the favorites list outright, e.g. to undo a change to it. */
  setFavorites(relPaths: readonly string[]): void {
    this.updateList('favorites', () => [...relPaths]);
  }

  removeFavorites(relPaths: readonly string[]): void {
    const removed = new Set(relPaths);
    this.updateList('favorites', (favorites) => favorites.filter((relPath) => !removed.has(relPath)));
  }

  /**
   * Moves `relPaths` — adding any that aren't favorites yet — so they sit
   * together, in the given order, right before `beforeRelPath`; at the end
   * when that's null or not a favorite. Backs drag-and-drop in the Favorites
   * section, for both reordering and dropping new notes in.
   */
  placeFavorites(relPaths: readonly string[], beforeRelPath: string | null): void {
    this.updateList('favorites', (favorites) => {
      const moving = [...new Set(relPaths)];
      const movingSet = new Set(moving);
      let anchor = beforeRelPath;
      // Dropping an entry right before itself: anchor on the next one that stays put.
      if (anchor !== null && movingSet.has(anchor)) {
        anchor = favorites.slice(favorites.indexOf(anchor) + 1).find((relPath) => !movingSet.has(relPath)) ?? null;
      }
      const rest = favorites.filter((relPath) => !movingSet.has(relPath));
      const index = anchor === null ? -1 : rest.indexOf(anchor);
      const at = index < 0 ? rest.length : index;
      return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    });
  }

  /** Repoints a favorite at a note's new path, keeping its position. */
  renameFavorite(oldRelPath: string, newRelPath: string): void {
    this.updateList('favorites', (favorites) => {
      if (oldRelPath === newRelPath || !favorites.includes(oldRelPath)) return favorites;
      return favorites
        .filter((relPath) => relPath !== newRelPath)
        .map((relPath) => (relPath === oldRelPath ? newRelPath : relPath));
    });
  }

  /** A note was renamed or moved in-app (or re-extensioned by encryption/conversion): follow it everywhere. */
  renameNote(oldRelPath: string, newRelPath: string): void {
    this.renameRecent(oldRelPath, newRelPath);
    this.renameFavorite(oldRelPath, newRelPath);
  }

  setSortMode(sortMode: SortMode): void {
    const meta = this.meta();
    if (!meta || meta.sortMode === sortMode) return;
    this.meta.set({ ...meta, sortMode });
    this.scheduleSave();
    const before = meta.sortMode;
    this.history.record({
      label: 'Change Sort Order',
      undo: async () => this.setSortMode(before),
      redo: async () => this.setSortMode(sortMode),
    });
  }

  /** Sorts the folder `relPath` by `mode`, or by the vault's sort order for null. Not for hidden folders, which aren't recorded. */
  setFolderSort(relPath: string, mode: SortMode | null): void {
    const meta = this.meta();
    const before = meta?.folderSort[relPath] ?? null;
    if (!meta || before === mode || this.hiddenPaths().has(relPath)) return;
    const { [relPath]: _, ...rest } = meta.folderSort;
    this.meta.set({ ...meta, folderSort: mode ? { ...rest, [relPath]: mode } : rest });
    this.scheduleSave();
    this.history.record({
      label: 'Change Folder Sort Order',
      undo: async () => this.setFolderSort(relPath, before),
      redo: async () => this.setFolderSort(relPath, mode),
    });
  }

  setFolderCollapsed(relPath: string, collapsed: boolean): void {
    if (this.hiddenPaths().has(relPath)) {
      this.sessionCollapsed.update((folders) => {
        const next = new Set(folders);
        if (collapsed) next.add(relPath);
        else next.delete(relPath);
        return next;
      });
      return;
    }
    this.updateList('collapsedFolders', (folders) =>
      collapsed ? (folders.includes(relPath) ? folders : [...folders, relPath]) : folders.filter((path) => path !== relPath),
    );
  }

  /** Collapses exactly `relPaths` (every folder, for Collapse All), or with an empty list expands them all. */
  setCollapsedFolders(relPaths: readonly string[]): void {
    const hidden = this.hiddenPaths();
    this.sessionCollapsed.set(new Set(relPaths.filter((path) => hidden.has(path))));
    this.updateList('collapsedFolders', () => relPaths.filter((path) => !hidden.has(path)));
  }

  /** A folder was renamed or moved in-app: its collapsed state, its manual order and everything in it follow it. */
  renameFolder(oldRelPath: string, newRelPath: string): void {
    const move = (path: string) =>
      path === oldRelPath || path.startsWith(`${oldRelPath}/`) ? newRelPath + path.slice(oldRelPath.length) : path;
    this.updateList('collapsedFolders', (folders) => folders.map(move));
    this.updateList('favorites', (favorites) => favorites.map(move));
    this.updateList('recentNotes', (recents) => recents.map((entry) => (move(entry.relPath) === entry.relPath ? entry : { ...entry, relPath: move(entry.relPath) })));
    const meta = this.meta();
    const moved = (keys: object) => Object.keys(keys).some((key) => move(key) !== key);
    if (!meta || (!moved(meta.order) && !moved(meta.folderSort))) return;
    const rekey = <T>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).map(([key, value]) => [move(key), value]));
    this.meta.set({ ...meta, order: rekey(meta.order), folderSort: rekey(meta.folderSort) });
    this.scheduleSave();
  }

  /** A folder was deleted in-app: forget that it, or anything in it, was collapsed. */
  forgetFolder(relPath: string): void {
    const gone = (path: string) => path === relPath || path.startsWith(`${relPath}/`);
    this.updateList('collapsedFolders', (folders) => folders.filter((path) => !gone(path)));
    const meta = this.meta();
    if (!meta || !Object.keys(meta.folderSort).some(gone)) return;
    this.meta.set({ ...meta, folderSort: Object.fromEntries(Object.entries(meta.folderSort).filter(([path]) => !gone(path))) });
    this.scheduleSave();
  }

  /** A note was deleted in-app: drop it from recents and favorites. */
  forgetNote(relPath: string): void {
    this.removeRecent(relPath);
    this.removeFavorites([relPath]);
  }

  private updateList<K extends 'recentNotes' | 'favorites' | 'collapsedFolders'>(key: K, update: (list: VaultMeta[K]) => VaultMeta[K]): void {
    const meta = this.meta();
    if (!meta) return;
    const current: readonly unknown[] = meta[key];
    const next = update(meta[key]);
    if (next.length === current.length && (next as readonly unknown[]).every((entry, i) => entry === current[i])) return;
    this.meta.set({ ...meta, [key]: next });
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }
}
