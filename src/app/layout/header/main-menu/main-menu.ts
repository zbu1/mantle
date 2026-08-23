import { Component, ElementRef, HostListener, signal, viewChild } from '@angular/core';
import { LucideMenu } from '@lucide/angular';
import { MenuItem } from '../../../shared/menu/menu-item';
import { MenuSurface } from '../../../shared/menu/menu-surface';

/**
 * The button at the start of the header that opens the app-level menu
 * (File, Edit, View, …).
 */
@Component({
  selector: 'app-main-menu',
  imports: [MenuSurface, MenuItem, LucideMenu],
  templateUrl: './main-menu.html',
  host: { class: 'relative flex shrink-0' },
})
export class MainMenu {
  protected readonly open = signal(false);

  private readonly trigger = viewChild<ElementRef<HTMLElement>>('trigger');
  // #panel is an <app-menu-surface>, so read its host element rather than the
  // component instance — see ContextMenu, which does the same for the same reason.
  private readonly panel = viewChild('panel', { read: ElementRef<HTMLElement> });

  protected toggle(): void {
    this.open.update((v) => !v);
  }

  protected close(): void {
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
