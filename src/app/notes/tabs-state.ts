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

/** A pane of the editor area: its own strip of tabs, one of them shown. */
export interface TabPane {
  kind: 'pane';
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

/** `row` puts its children side by side, `column` one above the other. */
export type SplitDirection = 'row' | 'column';

/** Panes (or further splits) laid out side by side or stacked, each taking a share (`sizes`, summing to 1). */
export interface TabSplit {
  kind: 'split';
  id: string;
  direction: SplitDirection;
  children: TabLayout[];
  sizes: number[];
}

export type TabLayout = TabPane | TabSplit;

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
  layout?: TabLayout;
}

const STORAGE_KEY = 'mantle.tabs.v2';

function createId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const newPane = (tabIds: string[] = [], activeTabId: string | null = tabIds[0] ?? null): TabPane => ({
  kind: 'pane',
  id: createId(),
  tabIds,
  activeTabId,
});

/** Every pane in `layout`, left to right and top to bottom. */
export function panesOf(layout: TabLayout): TabPane[] {
  return layout.kind === 'pane' ? [layout] : layout.children.flatMap(panesOf);
}

/** `layout` with each pane replaced by what `fn` returns, dropping nulls and collapsing splits left with one child. */
function mapPanes(layout: TabLayout, fn: (pane: TabPane) => TabLayout | null): TabLayout | null {
  if (layout.kind === 'pane') return fn(layout);
  const kept = layout.children
    .map((child, i) => [mapPanes(child, fn), layout.sizes[i]] as const)
    .filter((entry): entry is readonly [TabLayout, number] => entry[0] !== null);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0][0];
  const total = kept.reduce((sum, [, size]) => sum + size, 0) || 1;
  return { ...layout, children: kept.map(([child]) => child), sizes: kept.map(([, size]) => size / total) };
}

/** A split whose shape and pane contents make sense; anything else isn't trusted from storage. */
function validLayout(layout: unknown, tabIds: ReadonlySet<string>): layout is TabLayout {
  const node = layout as TabLayout;
  if (node?.kind === 'pane') {
    return typeof node.id === 'string' && Array.isArray(node.tabIds) && node.tabIds.every((id) => tabIds.has(id));
  }
  return (
    node?.kind === 'split' &&
    (node.direction === 'row' || node.direction === 'column') &&
    Array.isArray(node.children) &&
    node.children.length >= 2 &&
    Array.isArray(node.sizes) &&
    node.sizes.length === node.children.length &&
    node.children.every((child) => validLayout(child, tabIds))
  );
}

function readFromStorage(): { tabs: NoteTab[]; layout: TabLayout; activePaneId: string } {
  const fallback = (tabs: NoteTab[] = [], activeId: string | null = null) => {
    const pane = newPane(tabs.map((tab) => tab.id), activeId ?? tabs[0]?.id ?? null);
    return { tabs, layout: pane as TabLayout, activePaneId: pane.id };
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback();
    const parsed = JSON.parse(raw) as PersistedTabsState;
    const tabs: NoteTab[] = Array.isArray(parsed.tabs)
      ? parsed.tabs
          .filter((tab: NoteTab) => !!tab?.id && !!tab?.noteId && typeof tab?.title === 'string')
          .map((tab: NoteTab) => ({ id: tab.id, noteId: tab.noteId, title: tab.title }))
      : [];
    const ids = new Set(tabs.map((tab) => tab.id));
    const activeId = ids.has(parsed.activeId ?? '') ? parsed.activeId : (tabs[0]?.id ?? null);
    const layout = parsed.layout;
    // Every tab in exactly one pane, or the layout isn't trusted.
    const placed = validLayout(layout, ids) ? panesOf(layout).flatMap((pane) => pane.tabIds) : [];
    if (!validLayout(layout, ids) || placed.length !== ids.size || new Set(placed).size !== ids.size) {
      return fallback(tabs, activeId);
    }
    const panes = panesOf(layout).map((pane) => ({
      ...pane,
      activeTabId: pane.tabIds.includes(pane.activeTabId ?? '') ? pane.activeTabId : (pane.tabIds[0] ?? null),
    }));
    const fixed = mapPanes(layout, (pane) => panes.find((p) => p.id === pane.id)!)!;
    const active = panes.find((pane) => pane.tabIds.includes(activeId ?? '')) ?? panes[0];
    return { tabs, layout: fixed, activePaneId: active.id };
  } catch {
    return fallback();
  }
}

/**
 * The open tabs and how the editor area is split into panes to show them.
 *
 * Every tab lives in exactly one pane of `layout`; panes nest in splits, side
 * by side or stacked, to any depth. One pane is active at a time, and its
 * shown tab is `activeId`, which is what "the active note" means everywhere.
 * Two panes may show the same note: `NotesState` keeps one document and save
 * state per note, which both editors share.
 */
@Injectable({ providedIn: 'root' })
export class TabsState {
  private readonly vaultRoot = inject(VaultRootState);
  // Tabs left over from a session whose vault is no longer open can't be shown.
  private readonly initial = this.vaultRoot.isOpen()
    ? readFromStorage()
    : (() => {
        const pane = newPane();
        return { tabs: [] as NoteTab[], layout: pane as TabLayout, activePaneId: pane.id };
      })();

  /** Every open tab, in every pane. */
  readonly tabs = signal<NoteTab[]>(this.initial.tabs);
  readonly layout = signal<TabLayout>(this.initial.layout);
  readonly activePaneId = signal<string>(this.initial.activePaneId);

  readonly panes = computed(() => panesOf(this.layout()));
  readonly activePane = computed(() => this.panes().find((pane) => pane.id === this.activePaneId()) ?? this.panes()[0]);
  /** The tab the active pane shows. */
  readonly activeId = computed(() => this.activePane()?.activeTabId ?? null);
  /** Whether the editor area is split. */
  readonly split = computed(() => this.layout().kind === 'split');

  /** One app-wide history, so back/forward also retrace switches between tabs and panes. */
  private readonly history = signal<NavHistory>({ back: [], forward: [] });

  readonly canGoBack = computed(() => this.history().back.length > 0);
  readonly canGoForward = computed(() => this.history().forward.length > 0);
  /** Where back leads, nearest first. */
  readonly backEntries = computed(() => [...this.history().back].reverse());
  /** Where forward leads, nearest first. */
  readonly forwardEntries = computed(() => this.history().forward);

  /** Hidden notes' relPaths, whose tabs are left out of what's persisted: their path is sealed. */
  private readonly hiddenNoteIds = signal<ReadonlySet<string>>(new Set());

  constructor() {
    effect(() => {
      const hidden = this.hiddenNoteIds();
      const tabs = this.tabs().filter((tab) => !hidden.has(tab.noteId));
      const kept = new Set(tabs.map((tab) => tab.id));
      const layout =
        mapPanes(this.layout(), (pane) => {
          const tabIds = pane.tabIds.filter((id) => kept.has(id));
          return tabIds.length || pane.tabIds.length === 0
            ? { ...pane, tabIds, activeTabId: kept.has(pane.activeTabId ?? '') ? pane.activeTabId : (tabIds[0] ?? null) }
            : null;
        }) ?? newPane();
      const snapshot: PersistedTabsState = {
        tabs,
        activeId: kept.has(this.activeId() ?? '') ? this.activeId() : (tabs[0]?.id ?? null),
        layout,
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

  /** The tabs of `paneId`, in strip order. */
  tabsOf(paneId: string): NoteTab[] {
    const pane = this.panes().find((p) => p.id === paneId);
    const byId = new Map(this.tabs().map((tab) => [tab.id, tab]));
    return pane ? pane.tabIds.flatMap((id) => byId.get(id) ?? []) : [];
  }

  paneOf(tabId: string): TabPane | undefined {
    return this.panes().find((pane) => pane.tabIds.includes(tabId));
  }

  /** Makes `paneId` the active pane, e.g. when it's clicked into. */
  focusPane(paneId: string): void {
    if (this.panes().some((pane) => pane.id === paneId)) this.activePaneId.set(paneId);
  }

  openNote(note: NoteRef): void {
    if (!this.vaultRoot.isOpen()) return;
    const pane = this.activePane();
    const tabs = this.tabsOf(pane.id);
    const existing = tabs.find((tab) => tab.noteId === note.id) ?? this.tabs().find((tab) => tab.noteId === note.id);
    if (existing) {
      this.setActive(existing.id);
      return;
    }

    if (!pane.activeTabId) {
      this.addTab(pane.id, note, true);
      return;
    }

    this.recordCurrent();
    const tabId = pane.activeTabId;
    this.tabs.update((all) => all.map((tab) => (tab.id === tabId ? { id: tab.id, noteId: note.id, title: note.title } : tab)));
  }

  openNoteInBackground(note: NoteRef): void {
    if (!this.vaultRoot.isOpen()) return;
    this.addTab(this.activePane().id, note, false);
  }

  /** Always opens `note` in a brand-new tab (rather than reusing/replacing the active tab). */
  openInNewTab(note: NoteRef): void {
    if (!this.vaultRoot.isOpen()) return;
    const existing = this.tabs().find((tab) => tab.noteId === note.id);
    if (existing) {
      this.setActive(existing.id);
      return;
    }
    this.addTab(this.activePane().id, note, true);
  }

  /**
   * Opens `note` in a new pane beside `paneId` (the active one by default):
   * to its right for `row`, below it for `column`. The note may already be
   * open elsewhere; both panes then show it.
   */
  openBeside(note: NoteRef, direction: SplitDirection = 'row', paneId = this.activePane().id): void {
    if (!this.vaultRoot.isOpen()) return;
    const tab: NoteTab = { id: createId(), noteId: note.id, title: note.title };
    const pane = newPane([tab.id]);
    this.recordCurrent();
    this.tabs.update((tabs) => [...tabs, tab]);
    this.layout.update((layout) => insertBeside(layout, paneId, pane, direction));
    this.activePaneId.set(pane.id);
  }

  /** Moves a tab to position `index` of `paneId`'s strip (another pane's, or its own to reorder), and shows it. */
  moveTab(tabId: string, paneId: string, index: number): void {
    const from = this.paneOf(tabId);
    if (!from || !this.panes().some((pane) => pane.id === paneId)) return;
    this.recordCurrent();
    this.layout.update(
      (layout) =>
        mapPanes(layout, (pane) => {
          if (pane.id === paneId) {
            const tabIds = pane.tabIds.filter((id) => id !== tabId);
            const at = Math.max(0, Math.min(pane.id === from.id && from.tabIds.indexOf(tabId) < index ? index - 1 : index, tabIds.length));
            return { ...pane, tabIds: [...tabIds.slice(0, at), tabId, ...tabIds.slice(at)], activeTabId: tabId };
          }
          if (pane.id !== from.id) return pane;
          return withoutTab(pane, tabId);
        }) ?? newPane(),
    );
    this.activePaneId.set(paneId);
  }

  /** Sets the shares of a split's children, e.g. while its divider is dragged. */
  resize(splitId: string, sizes: number[]): void {
    const visit = (node: TabLayout): TabLayout =>
      node.kind === 'pane' ? node : node.id === splitId ? { ...node, sizes } : { ...node, children: node.children.map(visit) };
    this.layout.update(visit);
  }

  closeTab(id: string): void {
    const pane = this.paneOf(id);
    if (!pane) return;
    this.tabs.update((tabs) => tabs.filter((tab) => tab.id !== id));
    this.layout.update((layout) => mapPanes(layout, (p) => (p.id === pane.id ? withoutTab(p, id) : p)) ?? newPane());
    if (!this.panes().some((p) => p.id === this.activePaneId())) this.activePaneId.set(this.panes()[0].id);
    this.pruneHistory(id);
  }

  setActive(id: string): void {
    const pane = this.paneOf(id);
    if (!pane || this.activeId() === id) return;
    this.recordCurrent();
    this.show(pane.id, id);
  }

  closeAllTabs(): void {
    const pane = newPane();
    this.tabs.set([]);
    this.layout.set(pane);
    this.activePaneId.set(pane.id);
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

  /** Goes back `steps` entries, as pressing back that many times would. */
  goBack(steps = 1): void {
    const current = this.currentEntry();
    const { back, forward } = this.history();
    if (!this.vaultRoot.isOpen() || !current || steps < 1 || steps > back.length) return;
    const at = back.length - steps;
    this.history.set({ back: back.slice(0, at), forward: [...back.slice(at + 1), current, ...forward] });
    this.restore(back[at]);
  }

  /** Goes forward `steps` entries, as pressing forward that many times would. */
  goForward(steps = 1): void {
    const current = this.currentEntry();
    const { back, forward } = this.history();
    if (!this.vaultRoot.isOpen() || !current || steps < 1 || steps > forward.length) return;
    this.history.set({ back: [...back, current, ...forward.slice(0, steps - 1)], forward: forward.slice(steps) });
    this.restore(forward[steps - 1]);
  }

  private addTab(paneId: string, note: NoteRef, activate: boolean): void {
    const tab: NoteTab = { id: createId(), noteId: note.id, title: note.title };
    if (activate) this.recordCurrent();
    this.tabs.update((tabs) => [...tabs, tab]);
    this.layout.update(
      (layout) =>
        mapPanes(layout, (pane) =>
          pane.id === paneId
            ? { ...pane, tabIds: [...pane.tabIds, tab.id], activeTabId: activate || !pane.activeTabId ? tab.id : pane.activeTabId }
            : pane,
        ) ?? newPane([tab.id]),
    );
    if (activate) this.activePaneId.set(paneId);
  }

  /** Shows `tabId` in `paneId` and makes that the active pane. */
  private show(paneId: string, tabId: string): void {
    this.layout.update((layout) => mapPanes(layout, (pane) => (pane.id === paneId ? { ...pane, activeTabId: tabId } : pane)) ?? layout);
    this.activePaneId.set(paneId);
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
    const pane = this.paneOf(entry.tabId);
    if (pane) this.show(pane.id, entry.tabId);
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

/** `pane` without `tabId`, showing its left neighbor (or the next tab) if it was shown; null once it's empty. */
function withoutTab(pane: TabPane, tabId: string): TabPane | null {
  const index = pane.tabIds.indexOf(tabId);
  const tabIds = pane.tabIds.filter((id) => id !== tabId);
  if (tabIds.length === 0) return null;
  const activeTabId = pane.activeTabId === tabId ? tabIds[Math.max(0, index - 1)] : pane.activeTabId;
  return { ...pane, tabIds, activeTabId };
}

/** `layout` with `pane` added beside the pane `paneId`, after it, in `direction`. */
function insertBeside(layout: TabLayout, paneId: string, pane: TabPane, direction: SplitDirection): TabLayout {
  if (layout.kind === 'pane') {
    return layout.id === paneId ? { kind: 'split', id: createId(), direction, children: [layout, pane], sizes: [0.5, 0.5] } : layout;
  }
  const index = layout.children.findIndex((child) => child.kind === 'pane' && child.id === paneId);
  if (index >= 0 && layout.direction === direction) {
    const half = layout.sizes[index] / 2;
    return {
      ...layout,
      children: [...layout.children.slice(0, index + 1), pane, ...layout.children.slice(index + 1)],
      sizes: [...layout.sizes.slice(0, index), half, half, ...layout.sizes.slice(index + 1)],
    };
  }
  return { ...layout, children: layout.children.map((child) => insertBeside(child, paneId, pane, direction)) };
}
