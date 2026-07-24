import { Injectable, effect, signal } from '@angular/core';
import { Note } from './note.model';
import { findNote } from './notes-data';

export interface NoteTab {
  id: string;
  noteId: string;
  title: string;
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
          .filter((tab: NoteTab) => !!tab?.id && !!findNote(tab?.noteId))
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

  openNote(note: Note): void {
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

    const replacement: NoteTab = { id: tabs[activeIndex].id, noteId: note.id, title: note.title };
    this.tabs.update((tabs) => tabs.map((tab, index) => (index === activeIndex ? replacement : tab)));
  }

  openNoteInBackground(note: Note): void {
    const tab: NoteTab = { id: createTabId(), noteId: note.id, title: note.title };
    this.tabs.update((tabs) => [...tabs, tab]);
  }

  closeTab(id: string): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    const nextTabs = tabs.filter((tab) => tab.id !== id);
    this.tabs.set(nextTabs);

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
}
