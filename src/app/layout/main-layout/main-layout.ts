import { Component, HostListener } from '@angular/core';
import { Header } from '../header/header';
import { Sidebar } from '../sidebar/sidebar';
import { ContentArea } from '../content/content-area/content-area';
import { ContextMenu } from '../../shared/context-menu/context-menu';

@Component({
  selector: 'app-main-layout',
  imports: [Header, Sidebar, ContentArea, ContextMenu],
  templateUrl: './main-layout.html',
})
export class MainLayout {
  // Clicking chrome outside the editor (sidebar items, header buttons, menus,
  // ...) shouldn't steal DOM focus from the editor — the click still fires
  // and does its job, but the editor keeps focus and its caret stays visible.
  @HostListener('mousedown', ['$event'])
  protected onMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
  }
}
