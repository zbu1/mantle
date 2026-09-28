import { Component, DestroyRef, inject, signal } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LucideCopy, LucideMinus, LucideSquare, LucideX } from '@lucide/angular';
import { isTauri } from '../../core/tauri-env';

/**
 * Minimize / maximize-restore / close buttons for the frameless window. Shared
 * by the header and the no-vault welcome screen, which replaces the header.
 */
@Component({
  selector: 'app-window-controls',
  imports: [LucideMinus, LucideSquare, LucideCopy, LucideX],
  templateUrl: './window-controls.html',
  host: { class: 'flex' },
})
export class WindowControls {
  private readonly destroyRef = inject(DestroyRef);

  protected readonly isMaximized = signal(false);

  constructor() {
    if (!isTauri()) return;

    const win = getCurrentWindow();
    win.isMaximized().then((maximized) => this.isMaximized.set(maximized));
    win.onResized(async () => this.isMaximized.set(await win.isMaximized())).then((unlisten) => {
      this.destroyRef.onDestroy(unlisten);
    });
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
