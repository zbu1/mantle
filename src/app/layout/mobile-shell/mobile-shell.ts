import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { LucideCommand, LucideFolderLock, LucidePlus, LucideSettings, LucideX } from '@lucide/angular';
import { androidBridge, isTauri } from '../../core/tauri-env';
import { CommandPaletteState } from '../../shared/command-palette/command-palette-state';
import { SettingsModalState } from '../../shared/settings/settings-modal-state';
import { TabsState } from '../../notes/tabs-state';
import { VaultRootState } from '../../notes/vault-root-state';
import { VaultState } from '../../notes/vault-state';
import { dirOf } from '../../notes/vault-tree.model';
import { ContentArea } from '../content/content-area/content-area';
import { Sidebar } from '../sidebar/sidebar';
import { SidebarState } from '../sidebar/sidebar-state';
import { VaultMenu } from '../vault-menu/vault-menu';
import { Welcome } from '../welcome/welcome';
import { MobileToolbar } from './mobile-toolbar';

/** Open overlays: menus (the editor's slash and link menus are always there, just hidden), dialogs, windows. */
const OVERLAY = '[role="dialog"], [role="menu"]:not(.invisible)';

/**
 * The Android app's layout, in place of the desktop header, icon rail and
 * split panes: one note at a time, the vault in a drawer (the sidebar's
 * `collapsed` is whether it's shut), and a bottom bar (`MobileToolbar`).
 * Before any of it, Android's "All files access", without which no vault
 * folder can be read.
 *
 * Android's back gesture closes whatever is on top (an overlay, the open
 * tabs, the drawer), then goes back through the notes, then leaves the app.
 */
@Component({
  selector: 'app-mobile-shell',
  imports: [ContentArea, Sidebar, VaultMenu, Welcome, MobileToolbar, LucideFolderLock, LucideSettings, LucideCommand, LucideX, LucidePlus],
  templateUrl: './mobile-shell.html',
  host: {
    class: 'flex min-h-0 flex-1 flex-col',
    '(touchstart)': 'swipeStart($event)',
    '(touchend)': 'swipeEnd($event)',
  },
})
export class MobileShell {
  protected readonly vaultRoot = inject(VaultRootState);
  protected readonly vaultState = inject(VaultState);
  protected readonly tabsState = inject(TabsState);
  protected readonly sidebarState = inject(SidebarState);
  protected readonly settings = inject(SettingsModalState);
  protected readonly commandPalette = inject(CommandPaletteState);

  protected readonly filesAccess = signal(androidBridge()?.hasFilesAccess() ?? true);
  protected readonly drawerOpen = computed(() => !this.sidebarState.collapsed());
  protected readonly tabsOpen = signal(false);

  protected readonly tabRows = computed(() =>
    this.tabsState.tabs().map((tab) => ({ tab, folder: tab.noteId ? dirOf(tab.noteId) : '', active: tab.id === this.tabsState.activeId() })),
  );

  constructor() {
    // Closing the last tab leaves the sheet with nothing to show.
    effect(() => {
      if (this.tabsOpen() && this.tabRows().length === 0) this.tabsOpen.set(false);
    });

    // Starts shut; the sidebar shuts it again when a note is opened from it.
    this.sidebarState.setCollapsed(true);

    // Granting access happens in Android's settings, so check again on coming back.
    const recheck = () => {
      if (document.visibilityState === 'visible') this.recheckFilesAccess();
    };
    document.addEventListener('visibilitychange', recheck);
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', recheck));

    if (isTauri()) {
      const listener = onBackButtonPress(() => this.back());
      destroyRef.onDestroy(() => void listener.then((l) => l.unregister()));
    }
  }

  protected recheckFilesAccess(): void {
    this.filesAccess.set(androidBridge()?.hasFilesAccess() ?? true);
  }

  protected requestFilesAccess(): void {
    androidBridge()?.requestFilesAccess();
  }

  private edgeSwipe: Touch | null = null;

  /** A swipe in from the left screen edge opens the drawer. */
  protected swipeStart(event: TouchEvent): void {
    const touch = event.touches[0];
    this.edgeSwipe = event.touches.length === 1 && touch.clientX < 24 ? touch : null;
  }

  protected swipeEnd(event: TouchEvent): void {
    const touch = event.changedTouches[0];
    if (this.edgeSwipe && touch.clientX - this.edgeSwipe.clientX > 60 && Math.abs(touch.clientY - this.edgeSwipe.clientY) < 40) this.openDrawer();
    this.edgeSwipe = null;
  }

  private sheetSwipe: Touch | null = null;

  protected sheetSwipeStart(event: TouchEvent): void {
    this.sheetSwipe = event.touches.length === 1 ? event.touches[0] : null;
  }

  /** A downward swipe on the tab sheet's header dismisses it. */
  protected sheetSwipeEnd(event: TouchEvent): void {
    const touch = event.changedTouches[0];
    if (this.sheetSwipe && touch.clientY - this.sheetSwipe.clientY > 50) this.tabsOpen.set(false);
    this.sheetSwipe = null;
  }

  protected openDrawer(): void {
    this.sidebarState.setCollapsed(false);
  }

  protected closeDrawer(): void {
    this.sidebarState.setCollapsed(true);
  }

  protected showTab(id: string): void {
    this.tabsState.setActive(id);
    this.tabsOpen.set(false);
  }

  protected newTab(): void {
    this.tabsState.openEmptyTab();
    this.tabsOpen.set(false);
  }

  protected closeAllTabs(): void {
    this.tabsState.closeAllTabs();
    this.tabsOpen.set(false);
  }

  private back(): void {
    if (document.querySelector(OVERLAY)) {
      // Every overlay closes on Escape, from wherever focus is.
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } else if (this.tabsOpen()) {
      this.tabsOpen.set(false);
    } else if (this.drawerOpen()) {
      this.closeDrawer();
    } else if (this.vaultState.managing()) {
      this.vaultState.managing.set(false);
    } else if (this.tabsState.canGoBack()) {
      this.tabsState.goBack();
    } else {
      androidBridge()?.moveToBack();
    }
  }
}
