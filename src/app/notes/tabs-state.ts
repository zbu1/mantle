import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { NoteRef } from './note.model';
import { VaultRootState } from './vault-root-state';

export interface NoteTab {
  id: string;
  noteId: string;
  title: string;
  /** True when the underlying file was removed outside the app (not persisted; recomputed on scan). */
  missing?: boolean;
}

/** A place back/forward can return to: a tab showing a note. */
interface NavEntry {
  tabId: string;
  noteId: string;
  title: string;
}

interface NavHistory {
  back: NavEntry[];
  forward: NavEntry[];
}

const sameEntry = (a: NavEntry, b: NavEntry) => a.tabId === b.tabId && a.noteId === b.noteId;

interface PersistedTabsState {
  tabs: NoteTab[];
  activeId: string | null;
}

const STORAGE_KEY = 'mantle.tabs.v2';

const DEFAULT_STATE: PersistedTabsState = {
  tabs: [],
  activeId: null,
};

function createTabId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readFromStorage(): PersistedTabsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    const tabs: NoteTab[] = Array.isArray(parsed.tabs)
      ? parsed.tabs
          .filter((tab: NoteTab) => !!tab?.id && !!tab?.noteId && typeof tab?.title === 'string')
          .map((tab: NoteTab) => ({ id: tab.id, noteId: tab.noteId, title: tab.title }))
      : [];
    const activeId = tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : (tabs[0]?.id ?? null);
    return { tabs, activeId };
  } catch {
    return DEFAULT_STATE;
  }
}

@Injectable({ providedIn: 'root' })
export class TabsState {
  private readonly vaultRoot = inject(VaultRootState);
  // Tabs left over from a session whose vault is no longer open can't be shown.
  private readonly initial = this.vaultRoot.isOpen() ? readFromStorage() : DEFAULT_STATE;

  readonly tabs = signal<NoteTab[]>(this.initial.tabs);
  readonly activeId = signal<string | null>(this.initial.activeId);
  /** One app-wide history, so back/forward also retrace switches between tabs. */
  private readonly history = signal<NavHistory>({ back: [], forward: [] });

  readonly canGoBack = computed(() => this.history().back.length > 0);
  readonly canGoForward = computed(() => this.history().forward.length > 0);

  /** Hidden notes' relPaths, whose tabs are left out of what's persisted: their path is sealed. */
  private readonly hiddenNoteIds = signal<ReadonlySet<string>>(new Set());

  constructor() {
    effect(() => {
      const hidden = this.hiddenNoteIds();
      const tabs = this.tabs().filter((tab) => !hidden.has(tab.noteId));
      const snapshot: PersistedTabsState = {
        tabs,
        activeId: tabs.some((tab) => tab.id === this.activeId()) ? this.activeId() : (tabs[0]?.id ?? null),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // storage unavailable (e.g. private browsing) — ignore
      }
    });
  }

  /** Sets which notes are hidden, as the latest scan found them. */
  setHiddenNoteIds(ids: ReadonlySet<string>): void {
    this.hiddenNoteIds.set(ids);
  }

  openNote(note: NoteRef): void {
    if (!this.vaultRoot.isOpen()) return;
    const tabs = this.tabs();
    const existing = tabs.find((tab) => tab.noteId === note.id);
    if (existing) {
      this.setActive(existing.id);
      return;
    }

    const activeId = this.activeId();
    const activeIndex = activeId ? tabs.findIndex((tab) => tab.id === activeId) : -1;
    if (activeIndex === -1) {
      const tab: NoteTab = { id: createTabId(), noteId: note.id, title: note.title };
      this.tabs.update((tabs) => [...tabs, tab]);
      this.setActive(tab.id);
      return;
    }

    this.recordCurrent();
    const replacement: NoteTab = { id: tabs[activeIndex].id, noteId: note.id, title: note.title };
    this.tabs.update((tabs) => tabs.map((tab, index) => (index === activeIndex ? replacement : tab)));
  }

  openNoteInBackground(note: NoteRef): void {
    if (!this.vaultRoot.isOpen()) return;
    const tab: NoteTab = { id: createTabId(), noteId: note.id, title: note.title };
    this.tabs.update((tabs) => [...tabs, tab]);
  }

  /** Always opens `note` in a brand-new tab (rather than reusing/replacing the active tab). */
  openInNewTab(note: NoteRef): void {
    if (!this.vaultRoot.isOpen()) return;
    const existing = this.tabs().find((tab) => tab.noteId === note.id);
    if (existing) {
      this.setActive(existing.id);
      return;
    }

    const tab: NoteTab = { id: createTabId(), noteId: note.id, title: note.title };
    this.tabs.update((tabs) => [...tabs, tab]);
    this.setActive(tab.id);
  }

  closeTab(id: string): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    const nextTabs = tabs.filter((tab) => tab.id !== id);
    this.tabs.set(nextTabs);

    if (this.activeId() === id) {
      const neighborIndex = index > 0 ? index - 1 : 0;
      this.activeId.set(nextTabs[neighborIndex]?.id ?? null);
    }
    this.pruneHistory(id);
  }

  setActive(id: string): void {
    if (this.activeId() === id) return;
    this.recordCurrent();
    this.activeId.set(id);
  }

  closeAllTabs(): void {
    this.tabs.set([]);
    this.activeId.set(null);
    this.history.set({ back: [], forward: [] });
  }

  closeByNoteId(noteId: string): void {
    for (const tab of this.tabs().filter((tab) => tab.noteId === noteId)) {
      this.closeTab(tab.id);
    }
  }

  /** Updates a tab's displayed title without changing its noteId (e.g. live typing before a rename commits to disk). */
  updateTabTitle(tabId: string, title: string): void {
    this.tabs.update((tabs) => tabs.map((tab) => (tab.id === tabId ? { ...tab, title } : tab)));
  }

  /** Repoints any open tabs for `oldNoteId` at `newNoteId` (e.g. after a move/cut-paste or an external rename). */
  renameNoteId(oldNoteId: string, newNoteId: string, newTitle: string): void {
    this.tabs.update((tabs) =>
      tabs.map((tab) =>
        tab.noteId === oldNoteId ? { ...tab, noteId: newNoteId, title: newTitle, missing: false } : tab,
      ),
    );
    const repoint = (list: NavEntry[]) =>
      list.map((e) => (e.noteId === oldNoteId ? { ...e, noteId: newNoteId, title: newTitle } : e));
    this.history.update(({ back, forward }) => ({ back: repoint(back), forward: repoint(forward) }));
  }

  /** Flags open tabs for `noteId` as pointing at a file that no longer exists on disk. */
  markMissing(noteId: string): void {
    this.tabs.update((tabs) => tabs.map((tab) => (tab.noteId === noteId ? { ...tab, missing: true } : tab)));
  }

  /** Clears the missing flag for open tabs on `noteId` (e.g. the file reappeared). */
  clearMissing(noteId: string): void {
    this.tabs.update((tabs) =>
      tabs.map((tab) => (tab.noteId === noteId && tab.missing ? { ...tab, missing: false } : tab)),
    );
  }

  goBack(): void {
    const current = this.currentEntry();
    const { back, forward } = this.history();
    if (!this.vaultRoot.isOpen() || !current || back.length === 0) return;
    this.history.set({ back: back.slice(0, -1), forward: [current, ...forward] });
    this.restore(back[back.length - 1]);
  }

  goForward(): void {
    const current = this.currentEntry();
    const { back, forward } = this.history();
    if (!this.vaultRoot.isOpen() || !current || forward.length === 0) return;
    this.history.set({ back: [...back, current], forward: forward.slice(1) });
    this.restore(forward[0]);
  }

  private currentEntry(): NavEntry | null {
    const tab = this.tabs().find((tab) => tab.id === this.activeId());
    return tab ? { tabId: tab.id, noteId: tab.noteId, title: tab.title } : null;
  }

  /** Pushes where we are now onto the back stack, ahead of a navigation. */
  private recordCurrent(): void {
    const current = this.currentEntry();
    if (!current) return;
    this.history.update(({ back }) => ({ back: [...back, current], forward: [] }));
  }

  private restore(entry: NavEntry): void {
    this.activeId.set(entry.tabId);
    this.tabs.update((tabs) =>
      tabs.map((tab) =>
        tab.id === entry.tabId && tab.noteId !== entry.noteId
          ? { ...tab, noteId: entry.noteId, title: entry.title }
          : tab,
      ),
    );
  }

  /** Forgets a closed tab's entries, and any that now just repeat their neighbor or where we are. */
  private pruneHistory(closedTabId: string): void {
    const current = this.currentEntry();
    // Both lists are walked outward from the current location, which sits next to their first entry.
    const prune = (list: NavEntry[]) => {
      const out: NavEntry[] = [];
      let prev = current;
      for (const e of list) {
        if (e.tabId === closedTabId || (prev && sameEntry(e, prev))) continue;
        out.push(e);
        prev = e;
      }
      return out;
    };
    this.history.update(({ back, forward }) => ({
      back: prune([...back].reverse()).reverse(),
      forward: prune(forward),
    }));
  }
}
