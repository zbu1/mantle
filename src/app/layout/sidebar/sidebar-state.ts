import { Injectable, computed, effect, signal } from '@angular/core';

export type SectionId = 'favorites' | 'recent' | 'workspace' | 'tags';

interface PersistedSidebarState {
  width: number;
  collapsed: boolean;
  sections: Record<SectionId, boolean>;
  tagsHeight: number;
}

const STORAGE_KEY = 'mantle.sidebar.v1';
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 180;
const MAX_WIDTH = 400;

// Dragging the resize handle to a width narrower than this snaps the sidebar
// fully closed instead of clamping to MIN_WIDTH; dragging back out past it
// (from the collapsed edge) snaps it back open.
export const COLLAPSE_THRESHOLD = MIN_WIDTH / 2;

const DEFAULT_TAGS_HEIGHT = 160;
const MIN_TAGS_HEIGHT = 80;
const MAX_TAGS_HEIGHT = 400;

const DEFAULT_STATE: PersistedSidebarState = {
  width: DEFAULT_WIDTH,
  collapsed: false,
  sections: { favorites: true, recent: true, workspace: true, tags: true },
  tagsHeight: DEFAULT_TAGS_HEIGHT,
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
      tagsHeight: clamp(Number(parsed.tagsHeight) || DEFAULT_TAGS_HEIGHT, MIN_TAGS_HEIGHT, MAX_TAGS_HEIGHT),
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
  readonly tagsHeight = signal<number>(this.initial.tagsHeight);

  // True while the sidebar is being drag-resized — used to suppress layout
  // transitions elsewhere (header toggle button, tab bar) so they don't lag
  // behind rapid pointermove updates.
  readonly resizing = signal(false);

  // The icon rail (to the left of this sidebar) is what remains visible when
  // collapsed, so the sidebar itself collapses fully away rather than to a
  // mini icon-only rail of its own.
  readonly effectiveWidth = computed(() => (this.collapsed() ? 0 : this.width()));

  constructor() {
    effect(() => {
      const snapshot: PersistedSidebarState = {
        width: this.width(),
        collapsed: this.collapsed(),
        sections: this.sections(),
        tagsHeight: this.tagsHeight(),
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

  setTagsHeight(px: number): void {
    this.tagsHeight.set(clamp(px, MIN_TAGS_HEIGHT, MAX_TAGS_HEIGHT));
  }

  toggleCollapsed(): void {
    this.collapsed.update((v) => !v);
  }

  setCollapsed(value: boolean): void {
    this.collapsed.set(value);
  }

  toggleSection(id: SectionId): void {
    this.sections.update((s) => ({ ...s, [id]: !s[id] }));
  }

  isSectionExpanded(id: SectionId): boolean {
    return this.sections()[id];
  }
}
