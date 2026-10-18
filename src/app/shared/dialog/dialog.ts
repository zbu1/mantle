import { Component, ElementRef, HostListener, computed, effect, inject, viewChild } from '@angular/core';
import { HelpPopover } from '../help-popover/help-popover';
import { DialogState } from './dialog-state';

/**
 * The single app-styled modal used in place of native OS confirm/alert
 * dialogs (see DialogState) — rendered once at the layout root, like
 * ContextMenu.
 *
 * Text fields are read from template refs rather than bound to signals, so a
 * typed password lives only in the DOM input and the one call that validates
 * it. (It also avoids pulling in FormsModule, which the app doesn't use.)
 */
@Component({
  selector: 'app-dialog',
  imports: [HelpPopover],
  templateUrl: './dialog.html',
})
export class Dialog {
  protected readonly state = inject(DialogState);
  protected readonly request = this.state.request;
  protected readonly busy = this.state.busy;
  protected readonly inlineError = this.state.inlineError;

  // Defaults focus onto Cancel for a destructive confirm, so a stray Enter
  // key can't trigger a delete — otherwise the confirm/OK button.
  protected readonly defaultButton = computed<'confirm' | 'cancel'>(() => {
    const req = this.request();
    if (req?.kind === 'confirm' && req.tone !== 'default') return 'cancel';
    return 'confirm';
  });

  private readonly confirmButton = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly passwordInput = viewChild<ElementRef<HTMLInputElement>>('passwordInput');
  private readonly confirmInput = viewChild<ElementRef<HTMLInputElement>>('confirmInput');
  private readonly promptInput = viewChild<ElementRef<HTMLInputElement>>('promptInput');
  private readonly checkboxInput = viewChild<ElementRef<HTMLInputElement>>('checkboxInput');

  constructor() {
    effect(() => {
      const req = this.request();
      if (!req) return;

      // Text-entry dialogs focus their first field; the others focus a button.
      if (req.kind === 'prompt') {
        this.promptInput()?.nativeElement.focus();
        return;
      }
      if (req.kind === 'password') {
        (this.nameInput() ?? this.passwordInput())?.nativeElement.focus();
        return;
      }

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

  /** Confirm a confirm or alert dialog, passing on a confirm's checkbox and whether its alt button was chosen. */
  protected confirm(alt = false): void {
    this.state.confirmAction(undefined, this.checkboxInput()?.nativeElement.checked ?? false, alt);
  }

  /** Confirm a prompt dialog with whatever is currently in its input. */
  protected submitPrompt(): void {
    this.state.confirmAction(this.promptInput()?.nativeElement.value ?? '');
  }

  /**
   * Validate a password dialog locally, then hand it to `DialogState`.
   *
   * The confirmation mismatch is caught here rather than in `submit` so a
   * simple typo never costs an IPC round trip (and, for creation, never
   * creates a profile under a password the user didn't mean).
   */
  protected submitPassword(): void {
    const req = this.request();
    if (!req || req.kind !== 'password' || this.busy()) return;

    const name = this.nameInput()?.nativeElement.value ?? '';
    const password = this.passwordInput()?.nativeElement.value ?? '';

    if (!password) {
      this.state.setInlineError('Enter a password.');
      return;
    }
    if (req.requireConfirm && password !== (this.confirmInput()?.nativeElement.value ?? '')) {
      this.state.setInlineError("Passwords don't match.");
      return;
    }

    void this.state.submitPassword({ name, password });
  }
}
