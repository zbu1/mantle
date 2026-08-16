import { Component, ElementRef, input, output, signal, viewChild } from '@angular/core';

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

  private readonly button = viewChild.required<ElementRef<HTMLButtonElement>>('button');

  // Browsers suppress the native :focus-visible ring for mouse-originated
  // focus, even when we call .focus() ourselves. Clicking a note that's
  // already selected doesn't change anything else on screen, so without a
  // forced ring there's no visible feedback that focus landed here and
  // Tab/Shift+Tab now continue from this item.
  protected readonly forceFocusRing = signal(false);

  protected onClick(event: MouseEvent): void {
    if (this.selected()) {
      this.forceFocusRing.set(true);
      this.button().nativeElement.focus();
    }
    this.clicked.emit(event);
  }

  protected onBlur(): void {
    this.forceFocusRing.set(false);
  }

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
