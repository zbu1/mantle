import { Component, DestroyRef, inject, signal } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LucideCopy, LucideMinus, LucidePanelLeft, LucideSquare, LucideX } from '@lucide/angular';
import { SidebarState } from '../sidebar/sidebar-state';

@Component({
  selector: 'app-header',
  imports: [LucidePanelLeft, LucideMinus, LucideSquare, LucideCopy, LucideX],
  templateUrl: './header.html',
})
export class Header {
  protected readonly sidebarState = inject(SidebarState);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly isMaximized = signal(false);

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
