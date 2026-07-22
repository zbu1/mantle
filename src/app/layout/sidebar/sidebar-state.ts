import { Injectable, computed, effect, signal } from '@angular/core';

export type SectionId = 'favorites' | 'recent' | 'vault' | 'tags';

interface PersistedSidebarState {
  width: number;
  collapsed: boolean;
  sections: Record<SectionId, boolean>;
}

const STORAGE_KEY = 'stash.sidebar.v1';
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 180;
const MAX_WIDTH = 400;
const RAIL_WIDTH = 52;

const DEFAULT_STATE: PersistedSidebarState = {
  width: DEFAULT_WIDTH,
  collapsed: false,
  sections: { favorites: true, recent: true, vault: true, tags: true },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readFromStorage(): PersistedSidebarState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    return {
      width: clamp(Number(parsed.width) || DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH),
      collapsed: Boolean(parsed.collapsed),
      sections: { ...DEFAULT_STATE.sections, ...(parsed.sections ?? {}) },
    };
  } catch {
    return DEFAULT_STATE;
  }
}

@Injectable({ providedIn: 'root' })
export class SidebarState {
  private readonly initial = readFromStorage();

  readonly width = signal<number>(this.initial.width);
  readonly collapsed = signal<boolean>(this.initial.collapsed);
  readonly sections = signal<Record<SectionId, boolean>>(this.initial.sections);

  readonly effectiveWidth = computed(() => (this.collapsed() ? RAIL_WIDTH : this.width()));

  constructor() {
    effect(() => {
      const snapshot: PersistedSidebarState = {
        width: this.width(),
        collapsed: this.collapsed(),
        sections: this.sections(),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // storage unavailable (e.g. private browsing) — ignore
      }
    });
  }

  setWidth(px: number): void {
    this.width.set(clamp(px, MIN_WIDTH, MAX_WIDTH));
  }

  toggleCollapsed(): void {
    this.collapsed.update((v) => !v);
  }

  toggleSection(id: SectionId): void {
    this.sections.update((s) => ({ ...s, [id]: !s[id] }));
  }

  isSectionExpanded(id: SectionId): boolean {
    return this.sections()[id];
  }
}
