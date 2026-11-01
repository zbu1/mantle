import { Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { STYLE_COLORS, STYLE_ICONS } from './item-style';
import { ItemStylePickerState } from './item-style-picker-state';

/** The modal behind "Set Icon…" and "Set Color…": one click picks and closes. */
@Component({
  selector: 'app-item-style-picker',
  imports: [LucideDynamicIcon],
  template: `
@if (state.kind(); as kind) {
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" (pointerdown)="onBackdrop($event)">
  <div #dialog tabindex="-1" role="dialog" aria-modal="true" [attr.aria-label]="kind === 'icon' ? 'Set icon' : 'Set color'"
    (keydown.escape)="state.dismiss()"
    class="w-[320px] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-3 text-surface-foreground shadow-xl outline-none animate-pop-in">
    <h2 class="text-sm font-semibold">{{ kind === 'icon' ? 'Set Icon' : 'Set Color' }}</h2>
    @if (kind === 'icon') {
    <div class="scrollbar-thin mt-2 grid max-h-64 grid-cols-6 gap-1 overflow-y-auto">
      @for (entry of icons; track entry[0]) {
      <button type="button" [attr.title]="entry[0]" [attr.aria-label]="entry[0]" (click)="state.choose(entry[0])"
        class="focus-ring-inset flex h-9 items-center justify-center rounded-md text-foreground/80 hover:bg-accent hover:text-foreground">
        <svg [lucideIcon]="entry[1]" [size]="16"></svg>
      </button>
      }
    </div>
    } @else {
    <div class="mt-2 flex flex-wrap gap-2">
      @for (color of colors; track color.id) {
      <button type="button" [attr.title]="color.label" [attr.aria-label]="color.label" (click)="state.choose(color.id)"
        class="focus-ring-inset size-7 rounded-full border border-border" [style.background]="color.css"></button>
      }
    </div>
    }
    <div class="mt-3 flex justify-end gap-2 text-xs">
      <button type="button" (click)="state.choose(null)" class="focus-ring-inset rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">Remove</button>
      <button type="button" (click)="state.dismiss()" class="focus-ring-inset rounded-md px-2 py-1 hover:bg-accent">Cancel</button>
    </div>
  </div>
</div>
}`,
})
export class ItemStylePicker {
  protected readonly state = inject(ItemStylePickerState);
  protected readonly icons = Object.entries(STYLE_ICONS);
  protected readonly colors = STYLE_COLORS;
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');

  constructor() {
    effect(() => this.dialog()?.nativeElement.focus());
  }

  protected onBackdrop(event: PointerEvent): void {
    if (event.target === event.currentTarget) this.state.dismiss();
  }
}
