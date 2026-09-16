import { Component, ElementRef, computed, effect, inject, viewChild } from '@angular/core';
import {
  LucideArrowLeft,
  LucideArrowRight,
  LucideChevronDown,
  LucideEllipsis,
  LucideExpand,
  LucideFileText,
  LucideFolderOpen,
  LucideLock,
  LucideLockOpen,
  LucideRefreshCw,
  LucideTriangleAlert,
} from '@lucide/angular';
import { TabsState, NoteTab } from '../../../notes/tabs-state';
import { NotesState, titleFromRelPath } from '../../../notes/notes-state';
import { CredentialsState } from '../../../notes/credentials-state';
import { EncryptionPanelState } from '../../../notes/encryption-panel/encryption-panel-state';
import { VaultState } from '../../../notes/vault-state';
import { NoteEditor } from '../../../notes/editor/note-editor';
import { ContextMenuState } from '../../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../../shared/context-menu/context-menu.model';
import { DialogState } from '../../../shared/dialog/dialog-state';
import { VaultNoteNode, flattenEncryptedNotes } from '../../../notes/vault-tree.model';

const RENAME_DEBOUNCE_MS = 1000;

@Component({
  selector: 'app-content-area',
  imports: [
    NoteEditor,
    LucideArrowLeft,
    LucideArrowRight,
    LucideExpand,
    LucideEllipsis,
    LucideLock,
    LucideLockOpen,
    LucideFileText,
    LucideChevronDown,
    LucideTriangleAlert,
    LucideRefreshCw,
    LucideFolderOpen,
  ],
  templateUrl: './content-area.html',
})
export class ContentArea {
  protected readonly tabsState = inject(TabsState);
  private readonly notesState = inject(NotesState);
  protected readonly vaultState = inject(VaultState);
  protected readonly credentialsState = inject(CredentialsState);
  private readonly encryptionPanelState = inject(EncryptionPanelState);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly dialogState = inject(DialogState);

  private readonly contentRoot = viewChild<ElementRef<HTMLElement>>('contentRoot');
  private readonly encryptionButton = viewChild<ElementRef<HTMLButtonElement>>('encryptionButton');
  private readonly pendingRenames = new Map<string, ReturnType<typeof setTimeout>>();

  protected readonly activeTab = computed<NoteTab | undefined>(() => {
    const activeId = this.tabsState.activeId();
    return activeId ? this.tabsState.tabs().find((t) => t.id === activeId) : undefined;
  });

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

  constructor() {
    // `NoteEditor` normally triggers the load itself, but the locked panel
    // replaces the editor — so without this nothing would ever ask for the
    // note, and a locked note could never report that it's locked.
    effect(() => {
      const tab = this.activeTab();
      if (tab) this.notesState.ensureLoaded(tab.noteId);
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

  protected notePath(tab: NoteTab): string {
    const segments = tab.noteId.split('/');
    segments.pop();
    return segments.length ? `${segments.join(' / ')} / ${tab.title}` : tab.title;
  }

  /** Reflects each keystroke into the tab title and sidebar entry right away; the on-disk rename is debounced. */
  protected onTitleInput(tab: NoteTab, value: string): void {
    this.tabsState.updateTabTitle(tab.id, value);
    this.vaultState.renameNoteInTree(tab.noteId, tab.noteId, value);
    this.scheduleRename(tab.id);
  }

  protected onTitleKeydown(event: KeyboardEvent, tab: NoteTab, input: HTMLInputElement): void {
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

  protected onTitleBlur(tab: NoteTab): void {
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
    if (!tab) return;

    const onDiskTitle = titleFromRelPath(tab.noteId);
    const newTitle = tab.title.trim();
    if (!newTitle || newTitle === onDiskTitle) {
      this.tabsState.updateTabTitle(tabId, newTitle || onDiskTitle);
      return;
    }

    try {
      const renamed = await this.vaultState.renameNote(tab.noteId, newTitle);
      this.notesState.renameNoteId(tab.noteId, renamed.relPath);
      this.tabsState.renameNoteId(tab.noteId, renamed.relPath, renamed.name);
      this.vaultState.renameNoteInTree(tab.noteId, renamed.relPath, renamed.name);
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

  protected onMoreClick(event: MouseEvent, tab: NoteTab): void {
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Copy Content', icon: 'copy', action: () => this.copyContent(tab.noteId) },
      { kind: 'item', label: 'Copy Title', icon: 'copy', action: () => navigator.clipboard.writeText(tab.title) },
    ];
    this.contextMenuState.open(event, items);
  }

  protected onContentContextMenu(event: MouseEvent): void {
    const tab = this.activeTab();
    if (!tab) return;

    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Copy Content', icon: 'copy', action: () => this.copyContent(tab.noteId) },
      { kind: 'item', label: 'Copy Title', icon: 'copy', action: () => navigator.clipboard.writeText(tab.title) },
      { kind: 'separator' },
      { kind: 'item', label: 'Close Tab', icon: 'close', action: () => this.tabsState.closeTab(tab.id) },
    ];
    this.contextMenuState.open(event, items);
  }

  private copyContent(noteId: string): void {
    const note = this.notesState.getNote(noteId);
    if (note) navigator.clipboard.writeText(note.content);
  }
}
