import { Component, ElementRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { LucideCheck, LucideChevronsUpDown, LucideFolderPlus, LucideFolders, LucideSettings } from '@lucide/angular';
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
 * The workspace/vault switcher in the top bar, alongside the editor tabs: a
 * compact button showing the current vault's name that opens a menu anchored
 * to itself (not the click position) for switching vaults, opening another
 * one, or reaching settings.
 */
@Component({
  selector: 'app-vault-menu',
  imports: [MenuSurface, MenuItem, MenuSeparator, LucideFolders, LucideChevronsUpDown, LucideCheck, LucideFolderPlus, LucideSettings],
  templateUrl: './vault-menu.html',
  host: { class: 'relative inline-flex min-w-0 shrink-0' },
})
export class VaultMenu {
  private readonly vaultState = inject(VaultState);

  protected readonly open = signal(false);

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

  protected openSettings(): void {
    this.close();
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
