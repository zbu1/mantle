import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LucideCopy, LucideMinus, LucidePanelLeft, LucidePlus, LucideSquare, LucideX } from '@lucide/angular';
import { isTauri } from '../../core/tauri-env';
import { SidebarState } from '../sidebar/sidebar-state';
import { TabsState } from '../../notes/tabs-state';
import { VaultState } from '../../notes/vault-state';

@Component({
  selector: 'app-header',
  imports: [LucidePanelLeft, LucideMinus, LucideSquare, LucideCopy, LucideX, LucidePlus],
  templateUrl: './header.html',
})
export class Header {
  protected readonly sidebarState = inject(SidebarState);
  protected readonly tabsState = inject(TabsState);
  private readonly vaultState = inject(VaultState);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly isMaximized = signal(false);
  protected readonly gridTemplateColumns = computed(
    () => `${this.sidebarState.effectiveWidth()}px 1fr auto`,
  );

  constructor() {
    if (!isTauri()) return;

    const win = getCurrentWindow();
    win.isMaximized().then((maximized) => this.isMaximized.set(maximized));
    win.onResized(async () => this.isMaximized.set(await win.isMaximized())).then((unlisten) => {
      this.destroyRef.onDestroy(unlisten);
    });
  }

  toggleSidebar(): void {
    this.sidebarState.toggleCollapsed();
  }

  protected activateTab(id: string): void {
    this.tabsState.setActive(id);
  }

  protected closeTab(event: Event, id: string): void {
    event.stopPropagation();
    this.tabsState.closeTab(id);
  }

  protected async onNewNote(): Promise<void> {
    const base = 'Untitled';
    for (let i = 0; i < 50; i++) {
      const name = i === 0 ? base : `${base} ${i + 1}`;
      try {
        const created = await this.vaultState.createNote('', name);
        this.tabsState.openInNewTab({ id: created.relPath, title: created.name });
        return;
      } catch {
        // name collision — try the next candidate
      }
    }
  }

  minimize(): void {
    if (isTauri()) getCurrentWindow().minimize();
  }

  toggleMaximize(): void {
    if (isTauri()) getCurrentWindow().toggleMaximize();
  }

  close(): void {
    if (isTauri()) getCurrentWindow().close();
  }
}
