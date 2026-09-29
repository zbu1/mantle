import { Injectable, computed, effect, signal } from '@angular/core';

/**
 * The sidebar's secondary sections, stacked below the vault tree. The tree
 * itself isn't a section: it's always shown and can't be collapsed.
 */
export type SectionId = 'favorites' | 'recent' | 'tags' | 'credentials';

/** Every sidebar section in display order, for menus that list them. */
export const SIDEBAR_SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: 'favorites', label: 'Favorites' },
  { id: 'recent', label: 'Recent Files' },
  { id: 'tags', label: 'Tags' },
  { id: 'credentials', label: 'Credential Profiles' },
];

const SECTION_IDS: ReadonlySet<string> = new Set(SIDEBAR_SECTIONS.map((s) => s.id));

interface PersistedSidebarState {
  width: number;
  collapsed: boolean;
  sections: Record<SectionId, boolean>;
  hidden: SectionId[];
}

const STORAGE_KEY = 'mantle.sidebar.v1';
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 180;
const MAX_WIDTH = 400;

// Dragging the resize handle to a width narrower than this snaps the sidebar
// fully closed instead of clamping to MIN_WIDTH; dragging back out past it
// (from the collapsed edge) snaps it back open.
export const COLLAPSE_THRESHOLD = MIN_WIDTH / 2;

const DEFAULT_STATE: PersistedSidebarState = {
  width: DEFAULT_WIDTH,
  collapsed: false,
  // `readFromStorage` spreads these under whatever is persisted, so adding a
  // section here back-fills existing users without a storage version bump.
  sections: { favorites: true, recent: true, tags: true, credentials: true },
  hidden: [],
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
      // Picked key by key: older versions also stored a `workspace` entry for
      // the vault tree, back when it was a collapsible section.
      sections: Object.fromEntries(
        SIDEBAR_SECTIONS.map(({ id }) => [id, typeof parsed.sections?.[id] === 'boolean' ? parsed.sections[id] : DEFAULT_STATE.sections[id]]),
      ) as Record<SectionId, boolean>,
      hidden: Array.isArray(parsed.hidden)
        ? SIDEBAR_SECTIONS.map((s) => s.id).filter((id) => SECTION_IDS.has(id) && parsed.hidden.includes(id))
        : [],
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
  /** Sections the user has hidden from the sidebar entirely (as opposed to collapsed). */
  readonly hiddenSections = signal<readonly SectionId[]>(this.initial.hidden);

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
        hidden: [...this.hiddenSections()],
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

  setCollapsed(value: boolean): void {
    this.collapsed.set(value);
  }

  toggleSection(id: SectionId): void {
    this.sections.update((s) => ({ ...s, [id]: !s[id] }));
  }

  isSectionExpanded(id: SectionId): boolean {
    return this.sections()[id];
  }

  isSectionVisible(id: SectionId): boolean {
    return !this.hiddenSections().includes(id);
  }

  toggleSectionVisibility(id: SectionId): void {
    this.hiddenSections.update((hidden) => (hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]));
  }
}
