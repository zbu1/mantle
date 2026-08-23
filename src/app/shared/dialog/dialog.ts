import { Component, ElementRef, HostListener, computed, effect, inject, viewChild } from '@angular/core';
import { DialogState } from './dialog-state';

/**
 * The single app-styled modal used in place of native OS confirm/alert
 * dialogs (see DialogState) — rendered once at the layout root, like
 * ContextMenu.
 */
@Component({
  selector: 'app-dialog',
  templateUrl: './dialog.html',
})
export class Dialog {
  protected readonly state = inject(DialogState);
  protected readonly request = this.state.request;

  // Defaults focus onto Cancel for a destructive confirm, so a stray Enter
  // key can't trigger a delete — otherwise the confirm/OK button.
  protected readonly defaultButton = computed<'confirm' | 'cancel'>(() => {
    const req = this.request();
    if (req?.kind === 'confirm' && req.tone !== 'default') return 'cancel';
    return 'confirm';
  });

  private readonly confirmButton = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');

  constructor() {
    effect(() => {
      if (!this.request()) return;
      const target = this.defaultButton() === 'cancel' ? this.cancelButton() : this.confirmButton();
      target?.nativeElement.focus();
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.request()) this.state.cancel();
  }

  protected onBackdropPointerDown(event: PointerEvent): void {
    if (event.target === event.currentTarget) this.state.cancel();
  }
}
