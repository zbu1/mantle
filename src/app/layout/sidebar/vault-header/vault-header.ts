import { Component, ElementRef, HostListener, effect, inject, model, output, signal, viewChild } from '@angular/core';
import {
  LucideArrowDownAZ,
  LucideArrowUpAZ,
  LucideCalendarPlus,
  LucideCheck,
  LucideClock,
  LucideEllipsis,
  LucideFileText,
  LucideFoldVertical,
  LucideFolderOpen,
  LucideFolderPlus,
  LucideKeyRound,
  LucideListOrdered,
  LucideLockKeyhole,
  LucidePlus,
  LucideSearch,
  LucideSettings,
  LucideStar,
  LucideTags,
  LucideUnfoldVertical,
  LucideX,
} from '@lucide/angular';
import { MenuItem } from '../../../shared/menu/menu-item';
import { MenuSeparator } from '../../../shared/menu/menu-separator';
import { MenuSurface } from '../../../shared/menu/menu-surface';
import { CredentialsState } from '../../../notes/credentials-state';
import { NewEncryptedNoteState } from '../../../notes/new-encrypted-note/new-encrypted-note-state';
import { VaultState } from '../../../notes/vault-state';
import { SettingsModalState } from '../../../shared/settings/settings-modal-state';
import { SectionId, SidebarState } from '../sidebar-state';

/** Session-only, not persisted — see `sortMode` below. */
type SortMode = 'name-asc' | 'name-desc' | 'modified' | 'created' | 'manual';

/**
 * The top of the sidebar: a filter for the tree, a New Note button, and one
 * overflow menu for everything else — creating other items, sort, which
 * sections show, and vault-wide actions. Pinned above the scrolling tree.
 */
@Component({
  selector: 'app-vault-header',
  imports: [
    MenuSurface,
    MenuItem,
    MenuSeparator,
    LucidePlus,
    LucideSearch,
    LucideX,
    LucideEllipsis,
    LucideFolderPlus,
    LucideLockKeyhole,
    LucideArrowDownAZ,
    LucideArrowUpAZ,
    LucideClock,
    LucideCalendarPlus,
    LucideListOrdered,
    LucideStar,
    LucideTags,
    LucideKeyRound,
    LucideFileText,
    LucideUnfoldVertical,
    LucideFoldVertical,
    LucideFolderOpen,
    LucideSettings,
    LucideCheck,
  ],
  templateUrl: './vault-header.html',
  host: { class: 'frame block shrink-0 rounded-t-xl border-b border-border px-3 pb-2.5 pt-2' },
})
export class VaultHeader {
  protected readonly vaultState = inject(VaultState);
  protected readonly credentialsState = inject(CredentialsState);
  protected readonly sidebarState = inject(SidebarState);
  private readonly newEncryptedNoteState = inject(NewEncryptedNoteState);
  private readonly settingsModalState = inject(SettingsModalState);

  /** The tree filter, owned by the sidebar. */
  readonly filter = model('');

  /** Sidebar owns note/folder creation (shared with the right-click menus); this just asks for it. */
  readonly newNote = output<void>();
  readonly newFolder = output<void>();

  protected readonly menuOpen = signal(false);

  /**
   * Cosmetic only — no vault tree ordering is wired to this yet (see
   * `goals/vault-state-future.md`'s "Folder sort mode override"). Selecting
   * one just moves the checkmark.
   */
  protected readonly sortMode = signal<SortMode>('name-asc');

  /** Stub — nothing renders differently yet. */
  protected readonly showExtensions = signal(false);

  protected readonly hasVault = () => !!this.vaultState.rootPath();

  // Drives which row in the menu is highlighted — see MenuItem.active.
  protected readonly hoveredItem = signal<string | null>(null);
  private readonly resetHoverOnMenuChange = effect(() => {
    this.menuOpen();
    this.hoveredItem.set(null);
  });

  private readonly trigger = viewChild<ElementRef<HTMLElement>>('trigger');
  private readonly panel = viewChild('panel', { read: ElementRef<HTMLElement> });

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  private closeMenu(): void {
    this.menuOpen.set(false);
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (!this.menuOpen()) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.trigger()?.nativeElement.contains(target)) return;
    if (this.panel()?.nativeElement.contains(target)) return;
    this.closeMenu();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.closeMenu();
  }

  @HostListener('window:blur')
  protected onWindowBlur(): void {
    this.closeMenu();
  }

  // ---- Filter ----

  protected onFilterInput(value: string): void {
    this.filter.set(value);
  }

  /** Esc clears the filter, or leaves the field if it's already empty. */
  protected onFilterEscape(event: Event, field: HTMLInputElement): void {
    event.stopPropagation();
    if (this.filter()) this.filter.set('');
    else field.blur();
  }

  protected clearFilter(field: HTMLInputElement): void {
    this.filter.set('');
    field.focus();
  }

  // ---- Create ----

  protected onNewNote(): void {
    this.closeMenu();
    this.newNote.emit();
  }

  protected onNewFolder(): void {
    this.closeMenu();
    this.newFolder.emit();
  }

  protected onNewEncryptedNote(): void {
    this.closeMenu();
    this.newEncryptedNoteState.open();
  }

  // ---- Sort ----

  protected setSortMode(mode: SortMode): void {
    this.closeMenu();
    this.sortMode.set(mode);
  }

  // ---- Sections ----

  protected toggleSection(id: SectionId): void {
    this.closeMenu();
    this.sidebarState.toggleSection(id);
  }

  protected toggleExtensions(): void {
    this.closeMenu();
    this.showExtensions.update((v) => !v);
  }

  // ---- Vault ----
  //
  // Expand/collapse-all have no shared expansion state to drive yet —
  // VaultTreeNode's `expanded` signal is local per node — so these are stubs.

  protected expandAllFolders(): void {
    this.closeMenu();
  }

  protected collapseAllFolders(): void {
    this.closeMenu();
  }

  protected async revealVault(): Promise<void> {
    this.closeMenu();
    await this.vaultState.revealInFileExplorer('');
  }

  protected async lockAllProfiles(): Promise<void> {
    this.closeMenu();
    await this.credentialsState.lockAll();
  }

  protected openVaultSettings(): void {
    this.closeMenu();
    this.settingsModalState.open();
  }
}
