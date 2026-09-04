import { Injectable, computed, effect, signal } from '@angular/core';
import { NoteRef } from './note.model';

export interface NoteTab {
  id: string;
  noteId: string;
  title: string;
  /** True when the underlying file was removed outside the app (not persisted; recomputed on scan). */
  missing?: boolean;
}

interface TabHistory {
  back: NoteRef[];
  forward: NoteRef[];
}

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
  private readonly initial = readFromStorage();

  readonly tabs = signal<NoteTab[]>(this.initial.tabs);
  readonly activeId = signal<string | null>(this.initial.activeId);
  private readonly historyByTabId = signal<Record<string, TabHistory>>({});

  readonly canGoBack = computed(() => {
    const id = this.activeId();
    return !!id && (this.historyByTabId()[id]?.back.length ?? 0) > 0;
  });

  readonly canGoForward = computed(() => {
    const id = this.activeId();
    return !!id && (this.historyByTabId()[id]?.forward.length ?? 0) > 0;
  });

  constructor() {
    effect(() => {
      const snapshot: PersistedTabsState = {
        tabs: this.tabs(),
        activeId: this.activeId(),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // storage unavailable (e.g. private browsing) — ignore
      }
    });
  }

  openNote(note: NoteRef): void {
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

    const previous: NoteRef = { id: tabs[activeIndex].noteId, title: tabs[activeIndex].title };
    const replacement: NoteTab = { id: tabs[activeIndex].id, noteId: note.id, title: note.title };
    this.tabs.update((tabs) => tabs.map((tab, index) => (index === activeIndex ? replacement : tab)));
    this.pushHistory(replacement.id, previous);
  }

  openNoteInBackground(note: NoteRef): void {
    const tab: NoteTab = { id: createTabId(), noteId: note.id, title: note.title };
    this.tabs.update((tabs) => [...tabs, tab]);
  }

  /** Always opens `note` in a brand-new tab (rather than reusing/replacing the active tab). */
  openInNewTab(note: NoteRef): void {
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
    this.historyByTabId.update(({ [id]: _removed, ...rest }) => rest);

    if (this.activeId() !== id) return;

    if (nextTabs.length === 0) {
      this.activeId.set(null);
      return;
    }
    const neighborIndex = index > 0 ? index - 1 : 0;
    this.activeId.set(nextTabs[neighborIndex].id);
  }

  setActive(id: string): void {
    this.activeId.set(id);
  }

  closeAllTabs(): void {
    this.tabs.set([]);
    this.activeId.set(null);
    this.historyByTabId.set({});
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
    const tabId = this.activeId();
    if (!tabId) return;
    const hist = this.historyByTabId()[tabId];
    if (!hist || hist.back.length === 0) return;

    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;

    const target = hist.back[hist.back.length - 1];
    const current: NoteRef = { id: tabs[index].noteId, title: tabs[index].title };
    this.historyByTabId.update((map) => ({
      ...map,
      [tabId]: { back: hist.back.slice(0, -1), forward: [current, ...hist.forward] },
    }));
    this.tabs.update((tabs) =>
      tabs.map((tab, i) => (i === index ? { ...tab, noteId: target.id, title: target.title } : tab)),
    );
  }

  goForward(): void {
    const tabId = this.activeId();
    if (!tabId) return;
    const hist = this.historyByTabId()[tabId];
    if (!hist || hist.forward.length === 0) return;

    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;

    const target = hist.forward[0];
    const current: NoteRef = { id: tabs[index].noteId, title: tabs[index].title };
    this.historyByTabId.update((map) => ({
      ...map,
      [tabId]: { back: [...hist.back, current], forward: hist.forward.slice(1) },
    }));
    this.tabs.update((tabs) =>
      tabs.map((tab, i) => (i === index ? { ...tab, noteId: target.id, title: target.title } : tab)),
    );
  }

  private pushHistory(tabId: string, previous: NoteRef): void {
    this.historyByTabId.update((map) => {
      const hist = map[tabId] ?? { back: [], forward: [] };
      return { ...map, [tabId]: { back: [...hist.back, previous], forward: [] } };
    });
  }
}
