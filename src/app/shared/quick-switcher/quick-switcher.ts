import { Component, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import { LucideFileSearch2, LucideFileText, LucideLock } from '@lucide/angular';
import { MenuItem } from '../menu/menu-item';
import { CommandPaletteState } from '../command-palette/command-palette-state';
import { CredentialsState } from '../../notes/credentials-state';
import { TabsState } from '../../notes/tabs-state';
import { VaultState } from '../../notes/vault-state';
import { VaultMetaState } from '../../notes/vault-meta-state';
import { flattenAllNotes, isNoteLocked } from '../../notes/vault-tree.model';
import { QuickSwitcherState } from './quick-switcher-state';
import { filterQuickSwitcherItems, QuickSwitcherItem, toQuickSwitcherItems } from './quick-switcher.model';

/**
 * "Go to note" overlay bound to Ctrl+P — rendered once at the layout root,
 * like `Dialog`/`SettingsModal`. Lists every note in the open vault (recently
 * opened ones first when the query is empty) and jumps to it in a tab on
 * selection; locked notes are shown (with a lock icon) rather than hidden,
 * since opening one still surfaces the "unlock to read it" state in the
 * content area. The "Open Recent Note…" command opens it limited to recents.
 */
@Component({
  selector: 'app-quick-switcher',
  imports: [MenuItem, LucideFileSearch2, LucideFileText, LucideLock],
  templateUrl: './quick-switcher.html',
})
export class QuickSwitcher {
  protected readonly state = inject(QuickSwitcherState);
  private readonly commandPaletteState = inject(CommandPaletteState);
  private readonly vaultState = inject(VaultState);
  private readonly tabsState = inject(TabsState);
  private readonly credentialsState = inject(CredentialsState);
  private readonly vaultMeta = inject(VaultMetaState);

  protected readonly query = this.state.query;
  protected readonly selectedIndex = signal(0);
  protected readonly hasVault = computed(() => !!this.vaultState.tree());

  private readonly allItems = computed<QuickSwitcherItem[]>(() => {
    const tree = this.vaultState.tree();
    return tree ? toQuickSwitcherItems(flattenAllNotes(tree)) : [];
  });

  protected readonly recentsOnly = this.state.recentsOnly;

  protected readonly results = computed(() =>
    filterQuickSwitcherItems(
      this.allItems(),
      this.query(),
      this.vaultMeta.recentNotes().map((recent) => recent.relPath),
      this.recentsOnly(),
    ),
  );

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');

  constructor() {
    effect(() => {
      if (this.state.isOpen()) this.input()?.nativeElement.focus();
    });
    // Keeps the highlighted row in range whenever the result set changes shape.
    effect(() => {
      this.results();
      this.selectedIndex.set(0);
    });
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      this.commandPaletteState.close();
      this.state.toggle();
      return;
    }
    if (!this.state.isOpen()) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      this.state.close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.confirmSelected();
    }
  }

  @HostListener('window:blur')
  protected onBlur(): void {
    this.state.close();
  }

  protected onBackdropPointerDown(event: PointerEvent): void {
    if (event.target === event.currentTarget) this.state.close();
  }

  protected onQueryInput(value: string): void {
    this.query.set(value);
  }

  protected hover(index: number): void {
    this.selectedIndex.set(index);
  }

  protected select(item: QuickSwitcherItem): void {
    this.open(item);
  }

  protected isLocked(item: QuickSwitcherItem): boolean {
    return isNoteLocked(item.note, this.credentialsState.unlockedIds());
  }

  private move(delta: number): void {
    const count = this.results().length;
    if (count === 0) return;
    this.selectedIndex.update((i) => (i + delta + count) % count);
  }

  private confirmSelected(): void {
    const item = this.results()[this.selectedIndex()];
    if (item) this.open(item);
  }

  private open(item: QuickSwitcherItem): void {
    this.tabsState.openNote({ id: item.note.relPath, title: item.note.name });
    this.state.close();
  }
}
