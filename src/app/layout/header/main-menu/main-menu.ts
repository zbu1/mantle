import { Component, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  LucideArrowLeft,
  LucideArrowRight,
  LucideBug,
  LucideCheck,
  LucideCheckCheck,
  LucideClipboardPaste,
  LucideClock,
  LucideCopy,
  LucideDoorOpen,
  LucideExpand,
  LucideFilePlus,
  LucideFileSearch,
  LucideFolderPlus,
  LucideFolderX,
  LucideFolders,
  LucideInfo,
  LucideKeyboard,
  LucideLayers,
  LucideLock,
  LucideMenu,
  LucidePanelLeft,
  LucideRedo2,
  LucideRefreshCw,
  LucideRotateCcw,
  LucideSave,
  LucideSaveAll,
  LucideScissors,
  LucideSearch,
  LucideSettings,
  LucideShieldCheck,
  LucideStar,
  LucideTags,
  LucideUndo2,
  LucideX,
  LucideZoomIn,
  LucideZoomOut,
} from '@lucide/angular';
import { MenuItem } from '../../../shared/menu/menu-item';
import { MenuSeparator } from '../../../shared/menu/menu-separator';
import { MenuSurface } from '../../../shared/menu/menu-surface';
import { VaultMenu } from '../../vault-menu/vault-menu';
import { DialogState } from '../../../shared/dialog/dialog-state';
import { SettingsModalState } from '../../../shared/settings/settings-modal-state';
import { CredentialsState } from '../../../notes/credentials-state';
import { NotesState } from '../../../notes/notes-state';
import { TabsState } from '../../../notes/tabs-state';
import { VaultRenameState } from '../../../notes/vault-rename-state';
import { VaultState } from '../../../notes/vault-state';
import { isTauri } from '../../../core/tauri-env';
import { SectionId, SidebarState } from '../../sidebar/sidebar-state';
import { EditCommand, EditContextState } from '../../../shared/edit-context-state';
import { ZoomState } from '../../../shared/zoom-state';
import { ISSUES_URL } from '../../../shared/command-palette/command-palette';

type MenuCategory = 'file' | 'edit' | 'view' | 'help';

/**
 * The button at the start of the header that opens the app-level menu bar.
 *
 * Clicking the hamburger button swaps it — and the vault switcher next to
 * it — for a horizontal File/Edit/View/Help bar that slides into the space
 * the hamburger button occupied. Hovering any of those opens its dropdown
 * immediately; clicking a top-level item, clicking a leaf item, clicking
 * outside, or Escape all close the whole bar and revert to the hamburger +
 * vault switcher.
 */
@Component({
  selector: 'app-main-menu',
  imports: [
    MenuSurface,
    MenuItem,
    MenuSeparator,
    VaultMenu,
    LucideMenu,
    LucideCheck,
    LucideFilePlus,
    LucideFolderPlus,
    LucideSave,
    LucideSaveAll,
    LucideSettings,
    LucideX,
    LucideLayers,
    LucideFolders,
    LucideFolderX,
    LucideLock,
    LucideDoorOpen,
    LucideUndo2,
    LucideRedo2,
    LucideScissors,
    LucideCopy,
    LucideClipboardPaste,
    LucideCheckCheck,
    LucideSearch,
    LucideFileSearch,
    LucidePanelLeft,
    LucideStar,
    LucideClock,
    LucideTags,
    LucideShieldCheck,
    LucideArrowLeft,
    LucideArrowRight,
    LucideExpand,
    LucideRefreshCw,
    LucideZoomIn,
    LucideZoomOut,
    LucideRotateCcw,
    LucideInfo,
    LucideKeyboard,
    LucideBug,
  ],
  templateUrl: './main-menu.html',
  host: { class: 'relative flex shrink-0 items-center gap-2' },
})
export class MainMenu {
  private readonly vaultState = inject(VaultState);
  protected readonly tabsState = inject(TabsState);
  private readonly notesState = inject(NotesState);
  private readonly renameState = inject(VaultRenameState);
  private readonly credentialsState = inject(CredentialsState);
  protected readonly sidebarState = inject(SidebarState);
  private readonly dialogState = inject(DialogState);
  private readonly settingsModalState = inject(SettingsModalState);
  protected readonly editContext = inject(EditContextState);
  protected readonly zoom = inject(ZoomState);

  /** Whether the horizontal File/Edit/View/Help bar is showing in place of the vault switcher. */
  protected readonly open = signal(false);
  /** Which category's dropdown is currently open, if any — only meaningful while `open()`. */
  protected readonly activeCategory = signal<MenuCategory | null>(null);

  // Drives which row in the open dropdown is highlighted, keyed by that
  // item's action name — see MenuItem.active for why this is JS-driven
  // rather than plain CSS :hover.
  protected readonly hoveredItem = signal<string | null>(null);
  private readonly resetHoverOnCategoryChange = effect(() => {
    this.activeCategory();
    this.hoveredItem.set(null);
  });

  protected readonly activeTab = computed(() => {
    const id = this.tabsState.activeId();
    return id ? this.tabsState.tabs().find((tab) => tab.id === id) : undefined;
  });
  protected readonly hasVault = computed(() => !!this.vaultState.rootPath());
  protected readonly hasActiveTab = computed(() => !!this.activeTab());
  protected readonly hasTabs = computed(() => this.tabsState.tabs().length > 0);

  // Wraps just the four category trigger buttons (not their dropdowns), so
  // clicks on them can be told apart from clicks on an open dropdown's items.
  private readonly menuBar = viewChild<ElementRef<HTMLElement>>('menuBar');
  // Only one category's dropdown is ever in the DOM at a time (behind an
  // @if), so a single ref covers whichever one is currently open — same
  // trick ContextMenu uses for its single panel.
  private readonly panel = viewChild('panel', { read: ElementRef<HTMLElement> });

  /** Swaps the vault switcher for the menu bar, or back. */
  protected toggle(): void {
    this.open.update((v) => !v);
    this.activeCategory.set(null);
  }

  /** Hovering a category opens its dropdown straight away. */
  protected hoverCategory(category: MenuCategory): void {
    this.activeCategory.set(category);
  }

  /** Closes the whole menu bar, reverting back to the hamburger + vault switcher. */
  protected closeMenu(): void {
    this.open.set(false);
    this.activeCategory.set(null);
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (!this.open()) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    // Clicks on a category button or inside its open dropdown are handled by
    // their own (click)/(selected) bindings — a top-level click closes the
    // menu too, but only after running whatever it's bound to.
    if (this.menuBar()?.nativeElement.contains(target)) return;
    if (this.panel()?.nativeElement.contains(target)) return;
    this.closeMenu();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.closeMenu();
  }

  @HostListener('window:blur')
  protected onBlur(): void {
    this.closeMenu();
  }

  /** The File menu's shortcuts: Ctrl+N, Ctrl+S, Ctrl+Shift+S, Ctrl+W. */
  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat) return;
    const key = event.key.toLowerCase();
    const action =
      key === 'n' && !event.shiftKey && this.hasVault()
        ? () => this.newNote()
        : key === 's'
          ? () => (event.shiftKey ? this.saveAll() : this.saveActiveNote())
          : key === 'w' && !event.shiftKey && this.hasActiveTab()
            ? () => this.closeActiveTab()
            : null;
    if (!action) return;
    event.preventDefault();
    void action();
  }

  // ---- File ----

  protected async newNote(): Promise<void> {
    this.closeMenu();
    await this.vaultState.createAndOpenNote();
  }

  protected async newFolder(): Promise<void> {
    this.closeMenu();
    if (!this.hasVault()) return;
    const created = await this.vaultState.createFolderWithUniqueName();
    this.renameState.renamingPath.set(created.relPath);
  }

  protected async saveActiveNote(): Promise<void> {
    this.closeMenu();
    const tab = this.activeTab();
    if (!tab) return;
    await this.notesState.flushPending([tab.noteId]);
  }

  protected async saveAll(): Promise<void> {
    this.closeMenu();
    await this.notesState.flushPending();
  }

  protected closeActiveTab(): void {
    this.closeMenu();
    const id = this.tabsState.activeId();
    if (id) this.tabsState.closeTab(id);
  }

  protected closeAllTabs(): void {
    this.closeMenu();
    this.tabsState.closeAllTabs();
  }

  protected async newVault(): Promise<void> {
    this.closeMenu();
    await this.vaultState.createVault();
  }

  protected async openVault(): Promise<void> {
    this.closeMenu();
    await this.vaultState.pickVault();
  }

  protected closeVault(): void {
    this.closeMenu();
    this.vaultState.closeVault();
  }

  protected async lockAllProfiles(): Promise<void> {
    this.closeMenu();
    await this.credentialsState.lockAll();
  }

  protected openSettings(): void {
    this.closeMenu();
    this.settingsModalState.open();
  }

  protected exit(): void {
    this.closeMenu();
    if (isTauri()) getCurrentWindow().close();
  }

  // ---- Edit ----

  /** Runs on the editor or the vault tree, whichever last had focus. */
  protected runEdit(command: EditCommand): void {
    this.closeMenu();
    this.editContext.run(command);
  }

  // Find in Note / Find in Vault are planned; their items show disabled.

  protected findInNote(): void {
    this.closeMenu();
  }

  protected findInVault(): void {
    this.closeMenu();
  }

  // ---- View ----

  protected toggleSidebar(): void {
    this.closeMenu();
    this.sidebarState.toggleCollapsed();
  }

  protected toggleSection(id: SectionId): void {
    this.closeMenu();
    this.sidebarState.toggleSection(id);
  }

  protected goBack(): void {
    this.closeMenu();
    this.tabsState.goBack();
  }

  protected goForward(): void {
    this.closeMenu();
    this.tabsState.goForward();
  }

  protected async toggleFullscreen(): Promise<void> {
    this.closeMenu();
    if (isTauri()) {
      const win = getCurrentWindow();
      const fullscreen = await win.isFullscreen();
      await win.setFullscreen(!fullscreen);
      return;
    }
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  }

  protected reload(): void {
    this.closeMenu();
    location.reload();
  }

  // ---- Help ----

  protected async showAbout(): Promise<void> {
    this.closeMenu();
    await this.dialogState.alert(
      'Mantle is a note-taking desktop app — an Obsidian-style vault of Markdown notes, with optional zero-knowledge encryption.',
      { title: 'About Mantle', confirmLabel: 'OK' },
    );
  }

  protected showShortcuts(): void {
    this.closeMenu();
    this.settingsModalState.open('shortcuts');
  }

  protected reportIssue(): void {
    this.closeMenu();
    if (isTauri()) void openUrl(ISSUES_URL);
    else window.open(ISSUES_URL, '_blank', 'noopener');
  }
}
