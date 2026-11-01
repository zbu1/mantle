import { Component, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import { VaultActions } from '../../notes/vault-actions';
import { HistoryState } from '../../notes/history/history-state';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  LucideArrowLeft,
  LucideArrowRight,
  LucideCommand,
  LucideFilePlus,
  LucideFolderPlus,
  LucideSave,
  LucideSettings,
  LucideStar,
  LucideX,
  LucideZoomIn,
  LucideZoomOut,
} from '@lucide/angular';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ZoomState } from '../zoom-state';
import { MenuItem } from '../menu/menu-item';
import { DialogState } from '../dialog/dialog-state';
import { QuickSwitcherState } from '../quick-switcher/quick-switcher-state';
import { SettingsModalState } from '../settings/settings-modal-state';
import { CredentialsState } from '../../notes/credentials-state';
import { NotesState } from '../../notes/notes-state';
import { TabsState } from '../../notes/tabs-state';
import { FavoritesState } from '../../notes/favorites-state';
import { VaultMetaState } from '../../notes/vault-meta-state';
import { VaultRenameState } from '../../notes/vault-rename-state';
import { VaultState } from '../../notes/vault-state';
import { SORT_MODES, flattenVaultNotes, folderPaths } from '../../notes/vault-tree.model';
import { isMobile, isTauri } from '../../core/tauri-env';
import { SectionId, SidebarState } from '../../layout/sidebar/sidebar-state';
import { CommandPaletteState } from './command-palette-state';
import { CommandPaletteItem, filterCommandPaletteItems } from './command-palette.model';

export const ISSUES_URL = 'https://github.com/zbu1/mantle/issues/new';

interface SectionDef {
  id: SectionId;
  label: string;
}

const SIDEBAR_SECTIONS: SectionDef[] = [
  { id: 'favorites', label: 'Favorites' },
  { id: 'recent', label: 'Recent Files' },
  { id: 'tags', label: 'Tags' },
  { id: 'credentials', label: 'Credential Profiles' },
];

/**
 * App-wide Command Palette bound to Ctrl+Shift+P — rendered once at the
 * layout root, like `Dialog`/`SettingsModal`.
 *
 * Only lists commands that are both real and runnable from here (not the Edit
 * menu's, which act on whatever had focus before the palette took it) and meaningfully
 * app-wide rather than needing a specific note/folder as its target (those
 * stay in their existing context menus). Each command also only appears when
 * it currently applies — e.g. "Save Note" only with a tab open — rather than
 * showing and disabling, since there's nothing useful to explain about why a
 * given command can't run right now.
 */
@Component({
  selector: 'app-command-palette',
  imports: [
    MenuItem,
    LucideCommand,
    LucideFilePlus,
    LucideFolderPlus,
    LucideSave,
    LucideX,
    LucideStar,
    LucideArrowLeft,
    LucideArrowRight,
    LucideSettings,
    LucideZoomIn,
    LucideZoomOut,
  ],
  templateUrl: './command-palette.html',
})
export class CommandPalette {
  protected readonly state = inject(CommandPaletteState);
  private readonly vaultState = inject(VaultState);
  private readonly vaultActions = inject(VaultActions);
  private readonly tabsState = inject(TabsState);
  private readonly notesState = inject(NotesState);
  private readonly renameState = inject(VaultRenameState);
  private readonly credentialsState = inject(CredentialsState);
  private readonly sidebarState = inject(SidebarState);
  private readonly settingsModalState = inject(SettingsModalState);
  private readonly quickSwitcherState = inject(QuickSwitcherState);
  private readonly dialogState = inject(DialogState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly favorites = inject(FavoritesState);
  private readonly zoom = inject(ZoomState);
  private readonly historyState = inject(HistoryState);

  protected readonly query = this.state.query;
  protected readonly selectedIndex = signal(0);

  private readonly activeTab = computed(() => {
    const id = this.tabsState.activeId();
    return id ? this.tabsState.tabs().find((tab) => tab.id === id) : undefined;
  });

  private readonly commands = computed<CommandPaletteItem[]>(() => {
    const hasVault = !!this.vaultState.rootPath();
    const hasRecents = this.vaultMeta.recentNotes().length > 0;
    const activeTab = this.activeTab();
    const hasTabs = this.tabsState.tabs().length > 0;
    const sidebarCollapsed = this.sidebarState.collapsed();

    const items: CommandPaletteItem[] = [
      {
        id: 'quick-switcher',
        label: 'Go to Note…',
        keywords: ['quick', 'switcher', 'open', 'find'],
        run: () => this.quickSwitcherState.open(),
      },
    ];

    if (hasVault) {
      items.push({
        id: 'new-note',
        label: 'New Note',
        icon: 'file-plus',
        keywords: ['create', 'note'],
        run: () => void this.vaultActions.createAndOpenNote(),
      });
      items.push({
        id: 'new-folder',
        label: 'New Folder',
        icon: 'folder-plus',
        keywords: ['create', 'folder', 'directory'],
        run: () => void this.newFolder(),
      });
      items.push({
        id: 'deleted-notes',
        label: 'Restore Deleted Note…',
        keywords: ['deleted', 'history', 'snapshot', 'recover', 'trash'],
        run: () => this.historyState.openDeleted(),
      });
      if (hasRecents) {
        items.push({
          id: 'open-recent-note',
          label: 'Open Recent Note…',
          keywords: ['recent', 'history', 'open', 'note', 'switch'],
          run: () => this.quickSwitcherState.open({ recentsOnly: true }),
        });
        items.push({
          id: 'clear-recent-files',
          label: 'Clear Recent Files',
          keywords: ['recent', 'history', 'clear', 'reset', 'forget'],
          run: () => this.vaultMeta.clearRecents(),
        });
      }
    }

    if (activeTab) {
      items.push({
        id: 'save',
        label: 'Save Note',
        icon: 'save',
        keywords: ['save', 'write'],
        run: () => void this.notesState.flushPending(activeTab.noteId ? [activeTab.noteId] : []),
      });
      items.push({
        id: 'close-tab',
        label: 'Close Tab',
        icon: 'x',
        keywords: ['close', 'tab'],
        run: () => this.tabsState.closeTab(activeTab.id),
      });
      const tree = this.vaultState.tree();
      const noteId = activeTab.noteId;
      if (noteId && this.vaultMeta.loaded() && tree && flattenVaultNotes(tree).has(noteId)) {
        const favorite = this.favorites.isFavorite(noteId);
        items.push({
          id: 'note-history',
          label: 'Note History…',
          keywords: ['history', 'snapshot', 'version', 'restore', 'diff'],
          run: () => this.historyState.openFor(noteId),
        });
        items.push({
          id: 'toggle-favorite',
          label: favorite ? 'Remove Note from Favorites' : 'Add Note to Favorites',
          icon: 'star',
          keywords: ['favorite', 'favourite', 'star', 'bookmark', 'pin'],
          run: () => this.favorites.toggle(noteId),
        });
      }
    }

    if (hasTabs) {
      items.push({
        id: 'save-all',
        label: 'Save All',
        keywords: ['save', 'all'],
        run: () => void this.notesState.flushPending(),
      });
      items.push({
        id: 'close-all-tabs',
        label: 'Close All Tabs',
        keywords: ['close', 'all', 'tabs'],
        run: () => this.tabsState.closeAllTabs(),
      });
    }

    items.push({
      id: 'new-vault',
      label: 'New Vault…',
      keywords: ['new', 'create', 'vault', 'folder'],
      run: () => void this.vaultState.createVault(),
    });

    items.push({
      id: 'open-vault',
      label: 'Open Vault…',
      keywords: ['open', 'vault', 'folder'],
      run: () => void this.vaultState.pickVault(),
    });

    if (hasVault) {
      items.push({
        id: 'close-vault',
        label: 'Close Vault',
        keywords: ['close', 'vault'],
        run: () => this.vaultState.closeVault(),
      });
    }

    items.push({
      id: 'lock-all',
      label: 'Lock All Profiles',
      keywords: ['lock', 'encryption', 'profiles'],
      run: () => void this.credentialsState.lockAll(),
    });

    items.push({
      id: 'toggle-sidebar',
      label: sidebarCollapsed ? 'Show Sidebar' : 'Hide Sidebar',
      keywords: ['sidebar', 'toggle', 'panel'],
      run: () => this.sidebarState.toggleCollapsed(),
    });

    for (const section of SIDEBAR_SECTIONS) {
      if (!this.sidebarState.isSectionVisible(section.id)) continue;
      const expanded = this.sidebarState.isSectionExpanded(section.id);
      items.push({
        id: `section-${section.id}`,
        label: `${expanded ? 'Collapse' : 'Expand'} ${section.label}`,
        keywords: ['sidebar', 'section', section.label.toLowerCase()],
        run: () => this.sidebarState.toggleSection(section.id),
      });
    }

    if (this.tabsState.canGoBack()) {
      items.push({
        id: 'go-back',
        label: 'Go Back',
        icon: 'arrow-left',
        keywords: ['back', 'navigate', 'history'],
        run: () => this.tabsState.goBack(),
      });
    }
    if (this.tabsState.canGoForward()) {
      items.push({
        id: 'go-forward',
        label: 'Go Forward',
        icon: 'arrow-right',
        keywords: ['forward', 'navigate', 'history'],
        run: () => this.tabsState.goForward(),
      });
    }

    const tree = this.vaultState.tree();
    if (tree && this.vaultMeta.loaded()) {
      items.push(
        {
          id: 'expand-all-folders',
          label: 'Expand All Folders',
          keywords: ['expand', 'open', 'folders', 'tree'],
          run: () => this.vaultMeta.setCollapsedFolders([]),
        },
        {
          id: 'collapse-all-folders',
          label: 'Collapse All Folders',
          keywords: ['collapse', 'close', 'folders', 'tree'],
          run: () => this.vaultMeta.setCollapsedFolders(folderPaths(tree)),
        },
        ...SORT_MODES.filter((mode) => mode.id !== this.vaultMeta.sortMode()).map((mode) => ({
          id: `sort-${mode.id}`,
          label: `Sort by ${mode.label}`,
          keywords: ['sort', 'order', 'tree'],
          run: () => this.vaultMeta.setSortMode(mode.id),
        })),
      );
    }
    items.push({
      id: 'show-extensions',
      label: this.sidebarState.showExtensions() ? 'Hide File Extensions' : 'Show File Extensions',
      keywords: ['extensions', 'markdown', 'md', 'sidebar'],
      run: () => this.sidebarState.showExtensions.update((show) => !show),
    });

    items.push(
      { id: 'zoom-in', label: 'Zoom In', icon: 'zoom-in', keywords: ['zoom', 'bigger', 'larger'], run: () => this.zoom.zoomIn() },
      { id: 'zoom-out', label: 'Zoom Out', icon: 'zoom-out', keywords: ['zoom', 'smaller'], run: () => this.zoom.zoomOut() },
      { id: 'reset-zoom', label: 'Reset Zoom', keywords: ['zoom', 'reset', 'actual'], run: () => this.zoom.reset() },
    );

    if (!isMobile) items.push({
      id: 'fullscreen',
      label: 'Toggle Fullscreen',
      keywords: ['fullscreen', 'maximize'],
      run: () => void this.toggleFullscreen(),
    });
    items.push({
      id: 'reload',
      label: 'Reload',
      keywords: ['reload', 'refresh'],
      run: () => location.reload(),
    });
    items.push({
      id: 'settings',
      label: 'Open Settings…',
      icon: 'settings',
      keywords: ['settings', 'preferences'],
      run: () => this.settingsModalState.open(),
    });
    if (!isMobile) items.push({
      id: 'shortcuts',
      label: 'Keyboard Shortcuts',
      keywords: ['keyboard', 'shortcuts', 'hotkeys', 'keys'],
      run: () => this.settingsModalState.open('shortcuts'),
    });
    items.push({
      id: 'report-issue',
      label: 'Report an Issue',
      keywords: ['bug', 'issue', 'feedback', 'report'],
      run: () => void (isTauri() ? openUrl(ISSUES_URL) : window.open(ISSUES_URL, '_blank', 'noopener')),
    });
    items.push({
      id: 'about',
      label: 'About Mantle',
      keywords: ['about', 'version'],
      run: () => void this.showAbout(),
    });

    if (isTauri() && !isMobile) {
      items.push({
        id: 'exit',
        label: 'Exit',
        keywords: ['exit', 'quit'],
        run: () => getCurrentWindow().close(),
      });
    }

    return items;
  });

  protected readonly results = computed(() => filterCommandPaletteItems(this.commands(), this.query()));

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
    if (mod && event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      this.quickSwitcherState.close();
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

  protected select(item: CommandPaletteItem): void {
    this.run(item);
  }

  private move(delta: number): void {
    const count = this.results().length;
    if (count === 0) return;
    this.selectedIndex.update((i) => (i + delta + count) % count);
  }

  private confirmSelected(): void {
    const item = this.results()[this.selectedIndex()];
    if (item) this.run(item);
  }

  private run(item: CommandPaletteItem): void {
    this.state.close();
    item.run();
  }

  private async newFolder(): Promise<void> {
    const created = await this.vaultActions.createFolderWithUniqueName();
    if (created) this.renameState.renamingPath.set(created.relPath);
  }

  private async toggleFullscreen(): Promise<void> {
    if (isTauri()) {
      const win = getCurrentWindow();
      const fullscreen = await win.isFullscreen();
      await win.setFullscreen(!fullscreen);
      return;
    }
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  }

  private async showAbout(): Promise<void> {
    await this.dialogState.alert(
      'Mantle is a note-taking desktop app. Your notes are Markdown files in a vault, with optional zero-knowledge encryption.',
      { title: 'About Mantle', confirmLabel: 'OK' },
    );
  }
}
