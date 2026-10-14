import { Component, ElementRef, HostListener, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { LucideCheck, LucideChevronsUpDown, LucideFolderOpen, LucideFolderPlus, LucideFolders, LucideLibrary } from '@lucide/angular';
import { MenuItem } from '../../shared/menu/menu-item';
import { MenuSeparator } from '../../shared/menu/menu-separator';
import { MenuSurface } from '../../shared/menu/menu-surface';
import { VaultState, vaultNameFromPath } from '../../notes/vault-state';

interface RecentVault {
  path: string;
  name: string;
  active: boolean;
}

/**
 * The workspace/vault switcher: a button showing the current vault's name
 * that opens a menu anchored to itself (not the click position) for switching
 * vaults, opening another one, or managing them on the welcome screen.
 *
 * Two looks for one menu: `compact` in the top bar alongside the editor tabs,
 * and `hero`, the vault's title at the top of the sidebar.
 */
@Component({
  selector: 'app-vault-menu',
  imports: [MenuSurface, MenuItem, MenuSeparator, LucideFolders, LucideChevronsUpDown, LucideCheck, LucideFolderOpen, LucideFolderPlus, LucideLibrary],
  templateUrl: './vault-menu.html',
  host: {
    class: 'relative inline-flex min-w-0',
    '[class.shrink-0]': "variant() === 'compact'",
    '[class.flex-1]': "variant() === 'hero'",
  },
})
export class VaultMenu {
  readonly variant = input<'compact' | 'hero'>('compact');

  private readonly vaultState = inject(VaultState);

  protected readonly open = signal(false);

  // Drives which row is highlighted, keyed by a vault path or a static
  // item's own key — see MenuItem.active for why this is JS-driven rather
  // than plain CSS :hover.
  protected readonly hoveredKey = signal<string | null>(null);
  private readonly resetHoverOnToggle = effect(() => {
    this.open();
    this.hoveredKey.set(null);
  });

  protected readonly vaultName = computed(() => {
    const path = this.vaultState.rootPath();
    return path ? vaultNameFromPath(path) : null;
  });

  protected readonly recentVaults = computed<RecentVault[]>(() => {
    const currentPath = this.vaultState.rootPath();
    return this.vaultState.recentVaults().map((path) => ({
      path,
      name: vaultNameFromPath(path),
      active: path === currentPath,
    }));
  });

  private readonly trigger = viewChild<ElementRef<HTMLElement>>('trigger');
  // #panel is an <app-menu-surface>, so read its host element rather than the
  // component instance — see ContextMenu, which does the same for the same reason.
  private readonly panel = viewChild('panel', { read: ElementRef<HTMLElement> });

  protected toggle(): void {
    this.open.update((v) => !v);
  }

  protected async switchVault(path: string): Promise<void> {
    this.close();
    await this.vaultState.switchVault(path);
  }

  protected async openAnotherVault(): Promise<void> {
    this.close();
    await this.vaultState.pickVault();
  }

  protected async createVault(): Promise<void> {
    this.close();
    await this.vaultState.createVault();
  }

  protected manageVaults(): void {
    this.close();
    this.vaultState.managing.set(true);
  }

  private close(): void {
    this.open.set(false);
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (!this.open()) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.trigger()?.nativeElement.contains(target)) return;
    if (this.panel()?.nativeElement.contains(target)) return;
    this.close();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.close();
  }

  @HostListener('window:blur')
  protected onBlur(): void {
    this.close();
  }
}
