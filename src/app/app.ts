import { Component, computed, effect, inject } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { isMobile } from './core/tauri-env';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MainLayout } from './layout/main-layout/main-layout';
import { NotesState } from './notes/notes-state';
import { TabsState } from './notes/tabs-state';
import { VaultState, vaultNameFromPath } from './notes/vault-state';

@Component({
  selector: 'app-root',
  imports: [MainLayout],
  templateUrl: './app.html',
})
export class App {
  private readonly tabsState = inject(TabsState);
  private readonly vaultState = inject(VaultState);
  private readonly notesState = inject(NotesState);

  /** "Note — Vault — Mantle", shown in the taskbar, alt-tab and on hovering the app icon. */
  private readonly windowTitle = computed(() => {
    const root = this.vaultState.rootPath();
    const activeId = this.tabsState.activeId();
    const tab = this.tabsState.tabs().find((t) => t.id === activeId);
    const locked = tab?.noteId && this.notesState.entry(tab.noteId)?.status === 'locked';
    return [tab && (locked ? `${tab.title} (locked)` : tab.title), root && vaultNameFromPath(root), 'Mantle']
      .filter(Boolean)
      .join(' — ');
  });

  constructor() {
    effect(() => {
      const title = this.windowTitle();
      document.title = title;
      if (isTauri() && !isMobile) void getCurrentWindow().setTitle(title);
    });

    // Android may kill a backgrounded app without warning, so edits go out as soon as it's hidden.
    if (isMobile) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.notesState.flushPending();
      });
    } else if (isTauri()) {
      // Every close path (title bar, File › Exit, Alt+F4) lands here: write out
      // debounced edits while the keys are still there, then lock. The Rust
      // side wipes keys again on exit as a backstop.
      void getCurrentWindow().onCloseRequested(async () => {
        await this.notesState.flushPending();
        await invoke('lock_all_credential_profiles').catch(() => {});
      });
    }
  }
}
