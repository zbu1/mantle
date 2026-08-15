import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-sidebar-item-button',
  imports: [],
  templateUrl: './sidebar-item-button.html',
})
export class SidebarItemButton {
  readonly label = input.required<string>();
  readonly collapsed = input(false);
  readonly selected = input(false);
  readonly clicked = output<MouseEvent>();
  readonly middleClicked = output<void>();
  readonly contextMenu = output<MouseEvent>();

  protected onContextMenu(event: MouseEvent): void {
    this.contextMenu.emit(event);
  }

  protected onMouseDown(event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
    }
  }

  protected onAuxClick(event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
      this.middleClicked.emit();
    }
  }
}
