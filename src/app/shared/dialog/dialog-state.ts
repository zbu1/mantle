import { Injectable, signal } from '@angular/core';
import { DialogRequest, DialogTone } from './dialog.model';

export interface ConfirmOptions {
  title: string;
  tone?: DialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface AlertOptions {
  title: string;
  tone?: DialogTone;
  confirmLabel?: string;
}

/** Drives the single app-styled modal rendered by `Dialog`, replacing native OS confirm/alert dialogs. */
@Injectable({ providedIn: 'root' })
export class DialogState {
  readonly request = signal<DialogRequest | null>(null);

  confirm(message: string, options: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.request.set({
        kind: 'confirm',
        title: options.title,
        message,
        tone: options.tone ?? 'default',
        confirmLabel: options.confirmLabel ?? 'Confirm',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        resolve,
      });
    });
  }

  alert(message: string, options: AlertOptions): Promise<void> {
    return new Promise<void>((resolve) => {
      this.request.set({
        kind: 'alert',
        title: options.title,
        message,
        tone: options.tone ?? 'default',
        confirmLabel: options.confirmLabel ?? 'OK',
        resolve,
      });
    });
  }

  confirmAction(): void {
    const req = this.request();
    if (!req) return;
    this.request.set(null);
    if (req.kind === 'confirm') req.resolve(true);
    else req.resolve();
  }

  cancel(): void {
    const req = this.request();
    if (!req) return;
    this.request.set(null);
    if (req.kind === 'confirm') req.resolve(false);
    else req.resolve();
  }
}
