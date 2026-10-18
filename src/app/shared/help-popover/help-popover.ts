import { Component, ElementRef, inject, input, signal } from '@angular/core';
import { LucideCircleQuestionMark } from '@lucide/angular';

/** A small `?` button that opens a short explanation below it. */
@Component({
  selector: 'app-help-popover',
  imports: [LucideCircleQuestionMark],
  template: `
    <button type="button" (click)="open.set(!open())" [attr.aria-expanded]="open()" [attr.aria-label]="label()"
      [title]="label()"
      class="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      <svg lucideCircleQuestionMark [size]="14"></svg>
    </button>
    @if (open()) {
      <div role="note"
        class="absolute right-0 top-full z-50 mt-1 w-72 whitespace-pre-line rounded-md border border-border bg-surface p-3 text-left text-xs font-normal text-muted-foreground shadow-card animate-pop-in">
        {{ text() }}
      </div>
    }
  `,
  host: {
    class: 'relative inline-flex',
    '(document:pointerdown)': 'closeOutside($event)',
    '(keydown.escape)': 'closeOnEscape($event)',
  },
})
export class HelpPopover {
  readonly text = input.required<string>();
  readonly label = input('What does this mean?');

  protected readonly open = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected closeOutside(event: PointerEvent): void {
    if (!this.host.nativeElement.contains(event.target as Node)) this.open.set(false);
  }

  /** Escape closes the popover first, not the dialog it may sit in. */
  protected closeOnEscape(event: Event): void {
    if (!this.open()) return;
    event.stopPropagation();
    this.open.set(false);
  }
}
