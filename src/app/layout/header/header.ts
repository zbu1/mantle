import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LucideCopy, LucideMinus, LucidePanelLeft, LucideSquare, LucideX } from '@lucide/angular';
import { SidebarState } from '../sidebar/sidebar-state';
import { TabsState } from '../../notes/tabs-state';

@Component({
  selector: 'app-header',
  imports: [LucidePanelLeft, LucideMinus, LucideSquare, LucideCopy, LucideX],
  templateUrl: './header.html',
})
export class Header {
  protected readonly sidebarState = inject(SidebarState);
  protected readonly tabsState = inject(TabsState);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly isMaximized = signal(false);
  protected readonly gridTemplateColumns = computed(
    () => `${this.sidebarState.effectiveWidth()}px 1fr auto`,
  );

  constructor() {
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

  minimize(): void {
    getCurrentWindow().minimize();
  }

  toggleMaximize(): void {
    getCurrentWindow().toggleMaximize();
  }

  close(): void {
    getCurrentWindow().close();
  }
}
