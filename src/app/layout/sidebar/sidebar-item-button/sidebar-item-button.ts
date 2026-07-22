import { Component, input } from '@angular/core';

@Component({
  selector: 'app-sidebar-item-button',
  imports: [],
  templateUrl: './sidebar-item-button.html',
})
export class SidebarItemButton {
  readonly label = input.required<string>();
  readonly collapsed = input(false);
}
