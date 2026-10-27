import { Component, ElementRef, afterNextRender, computed, inject, input, signal, viewChild } from '@angular/core';
import { LucideFilePlus, LucideFileText, LucideLock, LucideSearch, LucideX } from '@lucide/angular';
import { MenuItem } from '../../shared/menu/menu-item';
import { filterQuickSwitcherItems, QuickSwitcherItem, toQuickSwitcherItems } from '../../shared/quick-switcher/quick-switcher.model';
import { CredentialsState } from '../credentials-state';
import { TabsState } from '../tabs-state';
import { VaultActions } from '../vault-actions';
import { VaultMetaState } from '../vault-meta-state';
import { VaultState } from '../vault-state';
import { flattenAllNotes, isNoteLocked } from '../vault-tree.model';

const MAX_ROWS = 20;

/** What an empty tab shows: a note search, the recent notes, and new note / close actions. */
@Component({
  selector: 'app-empty-tab',
  imports: [MenuItem, LucideFilePlus, LucideFileText, LucideLock, LucideSearch, LucideX],
  template: `
    <div class="mx-auto flex w-full max-w-xl flex-col gap-4 px-6 pt-[12vh] pb-6">
      <div class="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 focus-within:border-ring">
        <svg lucideSearch [size]="15" class="shrink-0 text-muted-foreground"></svg>
        <input #input type="text" [value]="query()" (input)="query.set(input.value); selectedIndex.set(0)"
          (keydown)="onKeydown($event)" placeholder="Search notes…" spellcheck="false" autocomplete="off"
          class="w-full min-w-0 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" />
      </div>
      <div>
        <div class="px-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {{ query().trim() ? 'Notes' : 'Recent Files' }}
        </div>
        @for (item of results(); track item.note.relPath; let i = $index) {
        <app-menu-item [label]="item.note.name" [active]="i === selectedIndex()" (hovered)="selectedIndex.set(i)" (selected)="open(item)">
          <svg menuItemIcon lucideFileText [size]="14"></svg>
          <span menuItemTrailing class="flex items-center gap-1 text-muted-foreground">
            @if (isLocked(item)) {
            <svg lucideLock [size]="12"></svg>
            }
            @if (item.dir) {
            <span class="max-w-40 truncate text-[11px]">{{ item.dir }}</span>
            }
          </span>
        </app-menu-item>
        } @empty {
        <div class="px-3 py-4 text-xs text-muted-foreground">{{ query().trim() ? 'No matching notes' : 'No recent notes yet' }}</div>
        }
      </div>
      <div class="flex flex-wrap gap-2 px-3">
        <button type="button" (click)="newNote()"
          class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-surface hover:text-foreground">
          <svg lucideFilePlus [size]="13"></svg> New note <span class="kbd">Ctrl+N</span>
        </button>
        <button type="button" (click)="tabsState.closeTab(tabId())"
          class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-surface hover:text-foreground">
          <svg lucideX [size]="13"></svg> Close tab <span class="kbd">Ctrl+W</span>
        </button>
      </div>
    </div>
  `,
})
export class EmptyTab {
  protected readonly tabsState = inject(TabsState);
  private readonly vaultState = inject(VaultState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly vaultActions = inject(VaultActions);
  private readonly credentialsState = inject(CredentialsState);

  readonly tabId = input.required<string>();

  protected readonly query = signal('');
  protected readonly selectedIndex = signal(0);
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');

  /** Recent notes for an empty query, else every note matching it. */
  protected readonly results = computed(() => {
    const tree = this.vaultState.tree();
    if (!tree) return [];
    const recents = this.vaultMeta.recentNotes().map((recent) => recent.relPath);
    const q = this.query();
    return filterQuickSwitcherItems(toQuickSwitcherItems(flattenAllNotes(tree)), q, recents, !q.trim()).slice(0, MAX_ROWS);
  });

  constructor() {
    afterNextRender(() => this.input().nativeElement.focus({ preventScroll: true }));
  }

  protected isLocked(item: QuickSwitcherItem): boolean {
    return isNoteLocked(item.note, this.credentialsState.unlockedIds());
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.results().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count) this.selectedIndex.update((i) => (i + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = this.results()[this.selectedIndex()];
      if (item) this.open(item);
    }
  }

  protected open(item: QuickSwitcherItem): void {
    this.tabsState.setActive(this.tabId());
    this.tabsState.openNote({ id: item.note.relPath, title: item.note.name });
  }

  protected newNote(): void {
    this.tabsState.setActive(this.tabId());
    void this.vaultActions.createAndOpenNote();
  }
}
