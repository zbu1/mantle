import { Component } from '@angular/core';

/** Divider between groups of <app-menu-item> rows. */
@Component({
  selector: 'app-menu-separator',
  template: '',
  host: { role: 'separator', class: 'my-1 block h-px bg-border' },
})
export class MenuSeparator {}
