import { Component, inject } from '@angular/core';
import { HoverTooltipState } from './hover-tooltip-state';

/** Single global tooltip surface, mounted once at the layout root — see `HoverTooltip`. */
@Component({
  selector: 'app-hover-tooltip-host',
  imports: [],
  templateUrl: './hover-tooltip-host.html',
  host: { class: 'contents' },
})
export class HoverTooltipHost {
  protected readonly state = inject(HoverTooltipState);
}
