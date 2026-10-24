import { Component, ElementRef, inject, viewChild } from '@angular/core';
import { MenuItem } from '../../../shared/menu/menu-item';
import { MenuSurface } from '../../../shared/menu/menu-surface';
import { LinkMenuState } from './link-menu-state';

/** The notes a `[[` being typed can link to; shown and placed by `wikilinkPlugin`. */
@Component({
  selector: 'app-link-menu',
  imports: [MenuSurface, MenuItem],
  template: `
    <app-menu-surface #panel [scrollable]="true" class="invisible pointer-events-none opacity-0 w-72 transition-opacity duration-100">
      @for (item of state.items(); track item.relPath; let i = $index) {
        <app-menu-item [label]="item.dir ? item.name + '  ·  ' + item.dir : item.name" [active]="i === state.selectedIndex()"
          (hovered)="state.selectedIndex.set(i)" (selected)="state.select(item)"></app-menu-item>
      }
    </app-menu-surface>
  `,
})
export class LinkMenu {
  protected readonly state = inject(LinkMenuState);
  private readonly panel = viewChild.required('panel', { read: ElementRef<HTMLElement> });

  panelElement(): HTMLElement {
    return this.panel().nativeElement;
  }
}
