import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { SidebarSection } from './sidebar-section/sidebar-section';
import { FAVORITES, RECENT_FILES, TAGS, VAULT_ITEMS } from './sidebar-data';
import { SidebarState } from './sidebar-state';

interface NavItem {
  label: string;
  path: string;
}

@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive, SidebarSection],
  templateUrl: './sidebar.html',
  host: { class: 'contents' },
})
export class Sidebar {
  protected readonly state = inject(SidebarState);

  protected readonly navItems: NavItem[] = [
    { label: 'Home', path: '/' },
    { label: 'Settings', path: '/settings' },
  ];

  protected readonly favorites = FAVORITES;
  protected readonly recentFiles = RECENT_FILES;
  protected readonly vaultItems = VAULT_ITEMS;
  protected readonly tags = TAGS;

  private readonly dragStartX = signal<number | null>(null);
  private readonly dragStartWidth = signal<number>(0);

  protected onResizePointerDown(event: PointerEvent): void {
    if (this.state.collapsed()) return;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    this.dragStartX.set(event.clientX);
    this.dragStartWidth.set(this.state.width());
  }

  protected onResizePointerMove(event: PointerEvent): void {
    const startX = this.dragStartX();
    if (startX === null) return;
    const delta = event.clientX - startX;
    this.state.setWidth(this.dragStartWidth() + delta);
  }

  protected onResizePointerUp(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    handle.releasePointerCapture(event.pointerId);
    this.dragStartX.set(null);
  }
}
