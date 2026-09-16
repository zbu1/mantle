import { Component, ElementRef, HostListener, effect, inject, output, signal, viewChild } from '@angular/core';
import {
  LucideArrowDownAZ,
  LucideArrowUpAZ,
  LucideCalendarPlus,
  LucideCheck,
  LucideClock,
  LucideEllipsis,
  LucideFilePlus,
  LucideFileText,
  LucideFoldVertical,
  LucideFolderOpen,
  LucideFolderPlus,
  LucideFolders,
  LucideListOrdered,
  LucideLockKeyhole,
  LucidePlus,
  LucideSettings,
  LucideSlidersHorizontal,
  LucideStar,
  LucideTags,
  LucideUnfoldVertical,
} from '@lucide/angular';
import { MenuItem } from '../../../shared/menu/menu-item';
import { MenuSeparator } from '../../../shared/menu/menu-separator';
import { MenuSurface } from '../../../shared/menu/menu-surface';
import { CredentialsState } from '../../../notes/credentials-state';
import { NoteEncryptionActions } from '../../../notes/note-encryption-actions';
import { VaultState } from '../../../notes/vault-state';
import { SettingsModalState } from '../../../shared/settings/settings-modal-state';
import { SectionId, SidebarState } from '../sidebar-state';

/** Session-only, not persisted — see `sortMode` below. */
type SortMode = 'name-asc' | 'name-desc' | 'modified' | 'created' | 'manual';

type ToolbarMenu = 'new' | 'sort' | 'view' | 'more';

/**
 * The horizontal icon rail at the top of the sidebar: quick-access buttons
 * for creating new items, plus Sort/View/More dropdowns, sitting above the
 * scrolling section list so they never scroll away with it.
 *
 * Each button owns an independent open/closed dropdown, but only one is ever
 * open at a time — opening one closes whichever else was open, the same
 * single-`activeMenu` approach `MainMenu` uses for its category bar.
 */
@Component({
  selector: 'app-sidebar-toolbar',
  imports: [
    MenuSurface,
    MenuItem,
    MenuSeparator,
    LucidePlus,
    LucideFilePlus,
    LucideFolderPlus,
    LucideLockKeyhole,
    LucideArrowDownAZ,
    LucideArrowUpAZ,
    LucideClock,
    LucideCalendarPlus,
    LucideListOrdered,
    LucideSlidersHorizontal,
    LucideStar,
    LucideFolders,
    LucideTags,
    LucideFileText,
    LucideEllipsis,
    LucideUnfoldVertical,
    LucideFoldVertical,
    LucideFolderOpen,
    LucideSettings,
    LucideCheck,
  ],
  templateUrl: './sidebar-toolbar.html',
  host: { class: 'flex shrink-0 items-center justify-center gap-0.5 px-1 pb-1' },
})
export class SidebarToolbar {
  protected readonly vaultState = inject(VaultState);
  protected readonly credentialsState = inject(CredentialsState);
  protected readonly sidebarState = inject(SidebarState);
  private readonly encryptionActions = inject(NoteEncryptionActions);
  private readonly settingsModalState = inject(SettingsModalState);

  /** Sidebar owns note/folder creation (shared with the right-click menus); this just asks for it. */
  readonly newNote = output<void>();
  readonly newFolder = output<void>();

  protected readonly activeMenu = signal<ToolbarMenu | null>(null);

  /**
   * Cosmetic only — no vault tree ordering is wired to this yet (see
   * `goals/vault-state-future.md`'s "Folder sort mode override"). Selecting
   * one just moves the checkmark.
   */
  protected readonly sortMode = signal<SortMode>('name-asc');

  /** Stub — nothing renders differently yet; here so the View menu isn't only a duplicate of the section toggles. */
  protected readonly showExtensions = signal(false);

  protected readonly hasVault = () => !!this.vaultState.rootPath();

  // Drives which row in the open dropdown is highlighted — see MenuItem.active.
  protected readonly hoveredItem = signal<string | null>(null);
  private readonly resetHoverOnMenuChange = effect(() => {
    this.activeMenu();
    this.hoveredItem.set(null);
  });

  // Wraps the four trigger buttons so outside-clicks can be told apart from
  // clicks that open one of them; only one dropdown is ever in the DOM at a
  // time, so a single ref covers whichever is open (same trick as MainMenu).
  private readonly rail = viewChild<ElementRef<HTMLElement>>('rail');
  private readonly panel = viewChild('panel', { read: ElementRef<HTMLElement> });

  protected toggleMenu(menu: ToolbarMenu): void {
    this.activeMenu.update((current) => (current === menu ? null : menu));
  }

  protected closeMenu(): void {
    this.activeMenu.set(null);
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (!this.activeMenu()) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.rail()?.nativeElement.contains(target)) return;
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

  // ---- New ----

  protected onNewNote(): void {
    this.closeMenu();
    this.newNote.emit();
  }

  protected onNewFolder(): void {
    this.closeMenu();
    this.newFolder.emit();
  }

  protected async newEncryptedNote(profileId?: string): Promise<void> {
    this.closeMenu();
    const id = profileId ?? (await this.credentialsState.promptCreate());
    if (!id) return;
    await this.encryptionActions.createEncryptedNote(id);
  }

  // ---- Sort ----

  protected setSortMode(mode: SortMode): void {
    this.closeMenu();
    this.sortMode.set(mode);
  }

  // ---- View ----

  protected toggleSection(id: SectionId): void {
    this.closeMenu();
    this.sidebarState.toggleSection(id);
  }

  protected toggleExtensions(): void {
    this.closeMenu();
    this.showExtensions.update((v) => !v);
  }

  // ---- More ----
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
