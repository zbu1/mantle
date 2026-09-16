import { Directive, ElementRef, OnDestroy, inject, input } from '@angular/core';
import { HoverTooltipState } from './hover-tooltip-state';

/** Delay before the tooltip appears — long enough that sweeping the pointer across the tree doesn't flash one per row. */
const SHOW_DELAY_MS = 500;

/**
 * Shows a floating label (name + optional sublabel) after the pointer rests
 * on the host element, styled like the icon rail's hover labels. Rendered by
 * the single `HoverTooltipHost` in the layout root rather than inline, so it
 * isn't clipped by an ancestor's `overflow` and isn't duplicated per row.
 */
@Directive({
  selector: '[appHoverTooltip]',
  host: {
    '(mouseenter)': 'onMouseEnter()',
    '(mouseleave)': 'onMouseLeave()',
  },
})
export class HoverTooltip implements OnDestroy {
  readonly appHoverTooltip = input.required<string>();
  readonly appHoverTooltipSublabel = input<string | null>(null);

  private readonly elementRef = inject(ElementRef<HTMLElement>);
  private readonly state = inject(HoverTooltipState);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private showing = false;

  protected onMouseEnter(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.showing = true;
      this.state.show(this.elementRef.nativeElement.getBoundingClientRect(), this.appHoverTooltip(), this.appHoverTooltipSublabel());
    }, SHOW_DELAY_MS);
  }

  protected onMouseLeave(): void {
    this.clearTimer();
    if (this.showing) {
      this.showing = false;
      this.state.hide();
    }
  }

  ngOnDestroy(): void {
    this.clearTimer();
    if (this.showing) this.state.hide();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
