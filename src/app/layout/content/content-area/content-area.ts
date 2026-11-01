import { Component, ElementRef, HostListener, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { VaultActions } from '../../../notes/vault-actions';
import {
  LucideArrowLeft,
  LucideArrowRight,
  LucideChevronDown,
  LucideChevronRight,
  LucideCodeXml,
  LucideEllipsis,
  LucideExpand,
  LucideFileText,
  LucideLock,
  LucideLockOpen,
  LucideMenu,
  LucideStar,
  LucideTriangleAlert,
  LucideX,
} from '@lucide/angular';
import { TabsState, NoteTab, NoteShowingTab } from '../../../notes/tabs-state';
import { NotesState, titleFromRelPath } from '../../../notes/notes-state';
import { CredentialsState } from '../../../notes/credentials-state';
import { EncryptionPanelState } from '../../../notes/encryption-panel/encryption-panel-state';
import { VaultState, vaultNameFromPath } from '../../../notes/vault-state';
import { FavoritesState } from '../../../notes/favorites-state';
import { VaultMetaState } from '../../../notes/vault-meta-state';
import { NoteEditor } from '../../../notes/editor/note-editor';
import { FindBar } from '../../../notes/editor/find-bar/find-bar';
import { FilePreview } from '../../../notes/file-preview/file-preview';
import { HelpPopover } from '../../../shared/help-popover/help-popover';
import { PropertiesPanel } from '../../../notes/properties-panel/properties-panel';
import { ContextMenuState } from '../../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../../shared/context-menu/context-menu.model';
import { DialogState } from '../../../shared/dialog/dialog-state';
import {
  VaultNoteNode,
  flattenEncryptedNotes,
  flattenVaultNotes,
  isNotePath,
  markdownExtensionOf,
} from '../../../notes/vault-tree.model';
import { MarkdownNoticeState } from '../../../notes/markdown-notice-state';
import { SidebarState } from '../../sidebar/sidebar-state';
import { CONVERT_HELP, NoteEncryptionActions } from '../../../notes/note-encryption-actions';
import { TabMenu } from '../../../notes/tab-menu';
import { FindRequestState } from '../../../notes/find-request-state';
import { EmptyTab } from '../../../notes/empty-tab/empty-tab';
import { isMobile } from '../../../core/tauri-env';

const RENAME_DEBOUNCE_MS = 1000;

@Component({
  selector: 'app-content-area',
  imports: [
    NoteEditor,
    EmptyTab,
    FindBar,
    FilePreview,
    HelpPopover,
    PropertiesPanel,
    LucideArrowLeft,
    LucideArrowRight,
    LucideExpand,
    LucideEllipsis,
    LucideLock,
    LucideLockOpen,
    LucideMenu,
    LucideFileText,
    LucideX,
    LucideChevronDown,
    LucideChevronRight,
    LucideCodeXml,
    LucideTriangleAlert,
    LucideStar,
  ],
  templateUrl: './content-area.html',
})
export class ContentArea {
  protected readonly tabsState = inject(TabsState);
  private readonly notesState = inject(NotesState);
  protected readonly vaultState = inject(VaultState);
  private readonly vaultActions = inject(VaultActions);
  protected readonly credentialsState = inject(CredentialsState);
  private readonly encryptionPanelState = inject(EncryptionPanelState);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly dialogState = inject(DialogState);
  private readonly encryptionActions = inject(NoteEncryptionActions);
  protected readonly markdownNotice = inject(MarkdownNoticeState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly favorites = inject(FavoritesState);
  protected readonly sidebarState = inject(SidebarState);
  protected readonly tabMenu = inject(TabMenu);
  protected readonly isMobile = isMobile;

  /** Mobile: the header slides away while reading down and returns on scrolling up. */
  protected readonly headerHidden = signal(false);
  private lastScroll = 0;

  protected onScroll(el: HTMLElement): void {
    const top = el.scrollTop;
    if (Math.abs(top - this.lastScroll) < 8) return;
    this.headerHidden.set(isMobile && top > this.lastScroll && top > 48);
    this.lastScroll = top;
  }

  private readonly contentRoot = viewChild<ElementRef<HTMLElement>>('contentRoot');
  protected readonly noteEditor = viewChild(NoteEditor);
  private readonly encryptionButton = viewChild<ElementRef<HTMLButtonElement>>('encryptionButton');
  private readonly pendingRenames = new Map<string, ReturnType<typeof setTimeout>>();

  /** The pane this shows; the active one if none is given. */
  readonly paneId = input<string | null>(null);

  private readonly pane = computed(
    () => this.tabsState.panes().find((pane) => pane.id === this.paneId()) ?? this.tabsState.activePane(),
  );
  private readonly isActivePane = computed(() => this.pane()?.id === this.tabsState.activePaneId());

  private readonly shownTab = computed<NoteTab | undefined>(() => {
    const activeId = this.pane()?.activeTabId;
    return activeId ? this.tabsState.tabs().find((t) => t.id === activeId) : undefined;
  });
  /** The tab this pane shows, unless it's empty. */
  protected readonly activeTab = computed(() => {
    const tab = this.shownTab();
    return tab?.noteId ? (tab as NoteShowingTab) : undefined;
  });
  /** The tab this pane shows while it's empty. */
  protected readonly emptyTab = computed(() => {
    const tab = this.shownTab();
    return tab && tab.noteId === null ? tab : undefined;
  });

  /** The active tab shows a file that isn't a note — an image, a PDF — in a read-only preview. */
  protected readonly activeIsFile = computed(() => {
    const tab = this.activeTab();
    return !!tab && !isNotePath(tab.noteId);
  });

  protected readonly vaultName = computed(() => vaultNameFromPath(this.vaultState.rootPath() ?? ''));

  /** The shown tab displays its note's Markdown source. */
  protected readonly sourceMode = computed(() => {
    const tab = this.activeTab();
    return !!tab && this.tabsState.sourceTabs().has(tab.id);
  });
  protected readonly sourceText = computed(() => {
    const tab = this.activeTab();
    return (tab && this.notesState.getNote(tab.noteId)?.content) ?? '';
  });

  protected onSourceInput(tab: NoteShowingTab, value: string): void {
    this.notesState.updateContent(tab.noteId, value);
  }

  /** Vault failed to open (bad/missing path, permissions, etc.) — show a fallback screen instead of the editor. */
  protected readonly vaultError = computed(() => (this.vaultState.tree() ? null : this.vaultState.error()));

  /** The active note's tree node, for its encryption state. */
  protected readonly activeNode = computed<VaultNoteNode | undefined>(() => {
    const tab = this.activeTab();
    const tree = this.vaultState.tree();
    if (!tab || !tree) return undefined;
    return flattenEncryptedNotes(tree).find((n) => n.relPath === tab.noteId);
  });

  /**
   * The credential profile of the active note while it's locked, or null.
   *
   * Read from the note's cached entry rather than the tree, so the panel also
   * covers a profile that was locked while the note was open.
   */
  protected readonly lockedProfileId = computed<string | null>(() => {
    const tab = this.activeTab();
    if (!tab) return null;
    const entry = this.notesState.entry(tab.noteId);
    return entry?.status === 'locked' ? entry.profileId : null;
  });

  protected readonly lockedProfileName = computed(() =>
    this.credentialsState.displayNameOf(this.lockedProfileId()),
  );

  /** True when the locked note names a profile this vault has no record of. */
  protected readonly lockedProfileUnknown = computed(() => {
    const id = this.lockedProfileId();
    return id !== null && !this.credentialsState.profileById(id);
  });

  /**
   * The active note's relPath while it can be favorited: it exists in the
   * vault and the vault's metadata has loaded. Null hides the star.
   */
  protected readonly favoritableNoteId = computed<string | null>(() => {
    const tab = this.activeTab();
    const tree = this.vaultState.tree();
    if (!tab || !tree || !this.vaultMeta.loaded()) return null;
    return flattenVaultNotes(tree).has(tab.noteId) ? tab.noteId : null;
  });

  protected readonly activeIsFavorite = computed(() => {
    const relPath = this.favoritableNoteId();
    return relPath !== null && this.favorites.isFavorite(relPath);
  });

  protected toggleActiveFavorite(): void {
    const relPath = this.favoritableNoteId();
    if (relPath !== null) this.favorites.toggle(relPath);
  }

  /** The find bar: null when closed, else whether it shows the replace field. */
  protected readonly find = signal<{ replace: boolean } | null>(null);
  private readonly findBar = viewChild(FindBar);

  @HostListener('document:keydown', ['$event'])
  protected onDocumentKeydown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    // Ctrl+F / Ctrl+H: the note's own find bar, never the WebView's.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (key === 'f' || key === 'h')) {
      event.preventDefault();
      if (!this.isActivePane() || !this.noteEditor() || this.sourceMode()) return;
      this.find.set({ replace: key === 'h' });
      this.findBar()?.focus();
      return;
    }
    if (!this.isActivePane()) return;
    // Esc in the note closes its find bar too, unless the editor used it (e.g. closing the slash menu).
    if (event.key === 'Escape' && !event.defaultPrevented && this.findBar()) {
      const dom = this.noteEditor()?.view?.dom;
      if (dom?.contains(event.target as Node)) {
        this.findBar()!.close(event);
        return;
      }
    }
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'b') return;
    if (this.favoritableNoteId() === null) return;
    event.preventDefault();
    if (!event.repeat) this.toggleActiveFavorite();
  }

  /** The active note's extension (e.g. `.md`) when it's a plain Markdown file, or null. */
  protected readonly activeMarkdownExt = computed(() => {
    const tab = this.activeTab();
    return tab ? markdownExtensionOf(tab.noteId) : null;
  });

  protected readonly convertHelp = CONVERT_HELP;

  protected convertActiveNote(): void {
    const note = this.plaintextNodeForActiveTab();
    if (note) void this.encryptionActions.convertToNotes([note]);
  }

  constructor() {
    const findRequests = inject(FindRequestState);
    effect(() => {
      const request = findRequests.request();
      if (!request) return;
      untracked(() => {
        if (!this.isActivePane() || !this.noteEditor() || this.sourceMode()) return;
        this.find.set({ replace: request.replace });
        this.findBar()?.focus();
      });
    });
    // `NoteEditor` normally triggers the load itself, but the locked panel
    // replaces the editor — so without this nothing would ever ask for the
    // note, and a locked note could never report that it's locked.
    effect(() => {
      const tab = this.activeTab();
      if (tab && !this.activeIsFile()) this.notesState.ensureLoaded(tab.noteId);
    });
  }

  protected async unlockActiveNote(): Promise<void> {
    const tab = this.activeTab();
    const profileId = this.lockedProfileId();
    if (!tab || profileId === null) return;
    if (await this.credentialsState.promptUnlock(profileId)) {
      this.notesState.reload(tab.noteId);
    }
  }

  /** True while the encryption panel is open for this tab's toolbar button. */
  protected readonly isEncryptionPanelOpen = computed(() => {
    const btn = this.encryptionButton()?.nativeElement;
    return !!btn && this.encryptionPanelState.target()?.anchor === btn;
  });

  /** Opens/closes the encryption panel anchored under the toolbar button. */
  protected onEncryptionClick(): void {
    const note = this.activeNode() ?? this.plaintextNodeForActiveTab();
    const btn = this.encryptionButton()?.nativeElement;
    if (!note || !btn) return;
    this.encryptionPanelState.toggle(btn, note);
  }

  /** A stand-in node for a plaintext active tab, which `flattenEncryptedNotes` skips. */
  private plaintextNodeForActiveTab(): VaultNoteNode | undefined {
    const tab = this.activeTab();
    if (!tab) return undefined;
    return {
      type: 'note',
      name: tab.title,
      relPath: tab.noteId,
      encrypted: false,
      profile: null,
      tags: null,
    };
  }

  protected retryOpenVault(): void {
    void this.vaultState.refresh();
  }

  protected pickAnotherVault(): void {
    void this.vaultState.pickVault();
  }

  protected goBack(): void {
    this.tabsState.goBack();
  }

  protected goForward(): void {
    this.tabsState.goForward();
  }

  /** Right-click on back or forward: that way's history, nearest first, to jump several steps at once. */
  protected openHistoryMenu(event: MouseEvent, forward: boolean): void {
    const entries = forward ? this.tabsState.forwardEntries() : this.tabsState.backEntries();
    if (entries.length === 0) return;
    this.contextMenuState.open(
      event,
      entries.map((entry, i) => ({
        kind: 'item' as const,
        label: entry.title,
        action: () => (forward ? this.tabsState.goForward(i + 1) : this.tabsState.goBack(i + 1)),
      })),
    );
  }

  /** The folders above the note, outermost first, each with its vault-relative path. */
  protected folderCrumbs(tab: NoteShowingTab): { name: string; relPath: string }[] {
    const segments = tab.noteId.split('/').slice(0, -1);
    return segments.map((name, i) => ({ name, relPath: segments.slice(0, i + 1).join('/') }));
  }

  /** Reflects each keystroke into the tab title and sidebar entry right away; the on-disk rename is debounced. */
  protected onTitleInput(tab: NoteShowingTab, value: string): void {
    this.tabsState.updateTabTitle(tab.id, value);
    this.vaultState.renameNoteInTree(tab.noteId, tab.noteId, value);
    this.scheduleRename(tab.id);
  }

  protected onTitleKeydown(event: KeyboardEvent, tab: NoteShowingTab, input: HTMLInputElement): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelPendingRename(tab.id);
      const onDiskTitle = titleFromRelPath(tab.noteId);
      input.value = onDiskTitle;
      this.tabsState.updateTabTitle(tab.id, onDiskTitle);
      this.vaultState.renameNoteInTree(tab.noteId, tab.noteId, onDiskTitle);
      input.blur();
    }
  }

  protected onTitleBlur(tab: NoteShowingTab): void {
    this.cancelPendingRename(tab.id);
    void this.commitRename(tab.id);
  }

  private scheduleRename(tabId: string): void {
    this.cancelPendingRename(tabId);
    this.pendingRenames.set(
      tabId,
      setTimeout(() => {
        this.pendingRenames.delete(tabId);
        void this.commitRename(tabId);
      }, RENAME_DEBOUNCE_MS),
    );
  }

  private cancelPendingRename(tabId: string): void {
    const existing = this.pendingRenames.get(tabId);
    if (existing) {
      clearTimeout(existing);
      this.pendingRenames.delete(tabId);
    }
  }

  private async commitRename(tabId: string): Promise<void> {
    const tab = this.tabsState.tabs().find((t) => t.id === tabId);
    if (!tab?.noteId) return;

    const onDiskTitle = titleFromRelPath(tab.noteId);
    const newTitle = tab.title.trim();
    if (!newTitle || newTitle === onDiskTitle) {
      this.tabsState.updateTabTitle(tabId, newTitle || onDiskTitle);
      return;
    }

    try {
      await this.vaultActions.rename('note', tab.noteId, newTitle);
    } catch (err) {
      this.tabsState.updateTabTitle(tabId, onDiskTitle);
      this.vaultState.renameNoteInTree(tab.noteId, tab.noteId, onDiskTitle);
      await this.dialogState.alert(String(err), { title: 'Rename Failed', tone: 'error' });
    }
  }

  protected toggleFullscreen(): void {
    const el = this.contentRoot()?.nativeElement;
    if (!el) return;

    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen();
    }
  }

  /** Right-click outside the editor (the toolbar, the title): the active tab's menu. */
  protected onContentContextMenu(event: MouseEvent): void {
    // A long press in text on Android is for selecting it.
    if (isMobile && (event.target as HTMLElement).closest('.ProseMirror, input, textarea')) return;
    const tab = this.activeTab();
    if (tab) this.tabMenu.open(event, tab);
  }

  protected onCrumbContextMenu(event: MouseEvent, relPath: string): void {
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Reveal in Sidebar', action: () => this.sidebarState.revealFolder(relPath) },
      { kind: 'item', label: 'New Note Here', icon: 'new-note', action: () => void this.vaultActions.createAndOpenNote(relPath) },
      { kind: 'separator' },
      { kind: 'item', desktopOnly: true, label: 'Show in File Explorer', icon: 'reveal', action: () => void this.vaultState.revealInFileExplorer(relPath) },
    ];
    this.contextMenuState.open(event, items);
  }
}
