import { Component, ElementRef, HostListener, effect, input, output, signal, viewChild } from '@angular/core';
import { LucideEllipsis, LucideKeyRound, LucideLock, LucideLockOpen, LucideSettings } from '@lucide/angular';
import { MenuItem } from '../../../shared/menu/menu-item';
import { MenuSurface } from '../../../shared/menu/menu-surface';

type ProfileMenuItem = 'settings' | 'lock' | 'password';

/**
 * The "…" trigger and dropdown for a credential profile row: Settings and
 * Change Master Password (neither wired up yet — there's no profile settings
 * screen to open) alongside a Lock/Unlock shortcut that mirrors the row's own
 * lock icon.
 *
 * Its own component (rather than inline in `CredentialProfileRow`) because
 * that row's template already carries two other reactive `@if` chains for the
 * lock icon and trailing label; a third sibling one for this dropdown was
 * silently failing to re-render on updates (an Angular content-projection
 * quirk), so the dropdown's own `@if` lives inside this separate component
 * instead.
 */
@Component({
  selector: 'app-profile-actions-menu',
  imports: [MenuItem, MenuSurface, LucideEllipsis, LucideKeyRound, LucideLock, LucideLockOpen, LucideSettings],
  templateUrl: './profile-actions-menu.html',
  host: { class: 'relative inline-flex shrink-0' },
})
export class ProfileActionsMenu {
  readonly displayName = input.required<string>();
  readonly unlocked = input(false);

  readonly toggleLock = output<void>();
  readonly openSettings = output<void>();
  readonly changePassword = output<void>();

  protected readonly open = signal(false);
  protected readonly hoveredItem = signal<ProfileMenuItem | null>(null);

  private readonly resetHoverOnToggle = effect(() => {
    this.open();
    this.hoveredItem.set(null);
  });

  private readonly trigger = viewChild<ElementRef<HTMLElement>>('trigger');
  // #panel is an <app-menu-surface>, so read its host element rather than the
  // component instance — see ContextMenu/VaultMenu, which do the same.
  private readonly panel = viewChild('panel', { read: ElementRef<HTMLElement> });

  protected onTriggerClick(event: MouseEvent): void {
    // Without this the click also reaches the row and toggles expansion.
    event.stopPropagation();
    this.open.update((v) => !v);
  }

  private close(): void {
    this.open.set(false);
  }

  protected onLock(): void {
    this.close();
    this.toggleLock.emit();
  }

  protected onSettings(): void {
    this.close();
    this.openSettings.emit();
  }

  protected onChangePassword(): void {
    this.close();
    this.changePassword.emit();
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
