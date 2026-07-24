import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-sidebar-item-button',
  imports: [],
  templateUrl: './sidebar-item-button.html',
})
export class SidebarItemButton {
  readonly label = input.required<string>();
  readonly collapsed = input(false);
  readonly clicked = output<void>();
  readonly middleClicked = output<void>();

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
