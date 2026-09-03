import { Component, input } from '@angular/core';

/**
 * The collapsible content under an `ExplorerRow`, animated via a CSS
 * grid-template-rows trick (0fr/1fr, rather than height, so it can transition
 * to/from an intrinsic height without knowing it up front).
 */
@Component({
  selector: 'app-explorer-body',
  templateUrl: './explorer-body.html',
  host: { class: 'contents' },
})
export class ExplorerBody {
  readonly expanded = input.required<boolean>();
}
