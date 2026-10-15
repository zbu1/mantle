import { Component, ElementRef, HostListener, computed, effect, inject, model, output, signal, viewChild } from '@angular/core';
import {
  LucideArrowDownAZ,
  LucideCheck,
  LucideChevronDown,
  LucideEllipsis,
  LucideEye,
  LucideFoldVertical,
  LucideFolderOpen,
  LucideFolderPlus,
  LucideLockKeyhole,
  LucidePlus,
  LucideSearch,
  LucideSettings,
  LucideUnfoldVertical,
  LucideX,
} from '@lucide/angular';
import { MenuItem } from '../../../shared/menu/menu-item';
import { MenuSeparator } from '../../../shared/menu/menu-separator';
import { MenuSurface } from '../../../shared/menu/menu-surface';
import { CredentialsState } from '../../../notes/credentials-state';
import { NewEncryptedNoteState } from '../../../notes/new-encrypted-note/new-encrypted-note-state';
import { VaultState } from '../../../notes/vault-state';
import { VaultMetaState } from '../../../notes/vault-meta-state';
import { SORT_MODES, SortMode, folderPaths } from '../../../notes/vault-tree.model';
import { SettingsModalState } from '../../../shared/settings/settings-modal-state';
import { SIDEBAR_SECTIONS, SectionId, SidebarState } from '../sidebar-state';

type HeaderMenu = 'sort' | 'display' | 'more';

/**
 * The top of the sidebar, pinned above the scrolling tree: a row of tree
 * actions (new note and folder, sort, expand/collapse, what the sidebar
 * shows, and an overflow menu for vault-wide actions), then the tree filter.
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
    LucideChevronDown,
    LucideEye,
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
  protected readonly vaultMeta = inject(VaultMetaState);

  protected readonly sortModes = SORT_MODES;
  protected readonly sections = SIDEBAR_SECTIONS;

  /** The tree filter, owned by the sidebar. */
  readonly filter = model('');

  /** Sidebar owns note/folder creation (shared with the right-click menus); this just asks for it. */
  readonly newNote = output<void>();
  readonly newFolder = output<void>();

  protected readonly openMenu = signal<HeaderMenu | null>(null);

  protected readonly hasVault = computed(() => !!this.vaultState.rootPath());

  private readonly folders = computed(() => {
    const tree = this.vaultState.tree();
    return tree ? folderPaths(tree) : [];
  });

  /** The expand/collapse toggle collapses while anything is open, and expands once everything is shut. */
  protected readonly anyFolderExpanded = computed(() => {
    const collapsed = this.vaultMeta.collapsedFolders();
    return this.folders().some((relPath) => !collapsed.has(relPath));
  });

  // Drives which row in the open menu is highlighted — see MenuItem.active.
  protected readonly hoveredItem = signal<string | null>(null);
  private readonly resetHoverOnMenuChange = effect(() => {
    this.openMenu();
    this.hoveredItem.set(null);
  });

  private readonly toolbar = viewChild<ElementRef<HTMLElement>>('toolbar');
  private readonly panel = viewChild('panel', { read: ElementRef<HTMLElement> });

  protected toggleMenu(menu: HeaderMenu): void {
    this.openMenu.update((open) => (open === menu ? null : menu));
  }

  private closeMenu(): void {
    this.openMenu.set(null);
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (!this.openMenu()) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    // The toolbar's own buttons toggle their menus themselves.
    if (this.toolbar()?.nativeElement.contains(target)) return;
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

  // ---- Toolbar ----

  protected onNewNote(): void {
    this.closeMenu();
    this.newNote.emit();
  }

  protected onNewFolder(): void {
    this.closeMenu();
    this.newFolder.emit();
  }

  protected setSortMode(mode: SortMode): void {
    this.closeMenu();
    this.vaultMeta.setSortMode(mode);
  }

  protected toggleAllFolders(): void {
    this.closeMenu();
    this.vaultMeta.setCollapsedFolders(this.anyFolderExpanded() ? this.folders() : []);
  }

  // Display options stay open, so several can be flipped in one go.

  protected toggleSectionVisibility(id: SectionId): void {
    this.sidebarState.toggleSectionVisibility(id);
  }

  protected toggleExtensions(): void {
    this.sidebarState.showExtensions.update((show) => !show);
  }

  // ---- More ----

  protected onNewEncryptedNote(): void {
    this.closeMenu();
    this.newEncryptedNoteState.open();
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
