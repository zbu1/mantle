import { Injectable, signal } from '@angular/core';
import { formatError, logError } from '../../core/logger';

const TOAST_MS = 2500;

/** A short message in a snackbar at the bottom of the window; a newer one replaces it. */
@Injectable({ providedIn: 'root' })
export class ToastState {
  readonly message = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  show(message: string): void {
    clearTimeout(this.timer);
    this.message.set(message);
    this.timer = setTimeout(() => this.message.set(null), TOAST_MS);
  }

  /** Puts `text` on the clipboard and says so. */
  copy(text: string): void {
    navigator.clipboard.writeText(text).then(
      () => this.show('Copied'),
      (err) => logError(`Failed to copy: ${formatError(err)}`),
    );
  }
}
