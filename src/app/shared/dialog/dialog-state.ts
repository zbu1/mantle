import { Injectable, signal } from '@angular/core';
import { DialogRequest, DialogTone, PasswordDialogValue } from './dialog.model';

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

export interface PromptOptions {
  title: string;
  tone?: DialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
  placeholder?: string;
  initialValue?: string;
}

export interface PasswordOptions {
  title: string;
  tone?: DialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Render a name field above the password (used when creating a profile). */
  nameLabel?: string;
  /** Render and validate a "confirm password" field. */
  requireConfirm?: boolean;
}

/** Drives the single app-styled modal rendered by `Dialog`, replacing native OS confirm/alert dialogs. */
@Injectable({ providedIn: 'root' })
export class DialogState {
  readonly request = signal<DialogRequest | null>(null);

  /**
   * True while a `password` request's `submit` is in flight — which can be a
   * few hundred milliseconds, since unlocking runs Argon2id. Dismissal is
   * blocked meanwhile so Escape can't tear the dialog down mid-derivation.
   */
  readonly busy = signal(false);

  /** Error shown inside an open `password` dialog, e.g. "Incorrect password". */
  readonly inlineError = signal<string | null>(null);

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

  /** Ask for a single line of text. Resolves the value, or null if cancelled. */
  prompt(message: string, options: PromptOptions): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.inlineError.set(null);
      this.request.set({
        kind: 'prompt',
        title: options.title,
        message,
        tone: options.tone ?? 'default',
        confirmLabel: options.confirmLabel ?? 'OK',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        placeholder: options.placeholder ?? '',
        initialValue: options.initialValue ?? '',
        resolve,
      });
    });
  }

  /**
   * Ask for a password, validating it through `submit` without closing.
   *
   * `submit` returns null on success (the dialog closes and this resolves
   * true), or a message to show inline while the dialog stays open with the
   * typed value intact.
   */
  password(
    message: string,
    options: PasswordOptions,
    submit: (value: PasswordDialogValue) => Promise<string | null>,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.inlineError.set(null);
      this.busy.set(false);
      this.request.set({
        kind: 'password',
        title: options.title,
        message,
        tone: options.tone ?? 'default',
        confirmLabel: options.confirmLabel ?? 'OK',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        nameLabel: options.nameLabel ?? null,
        requireConfirm: options.requireConfirm ?? false,
        submit,
        resolve,
      });
    });
  }

  /** Run an open password dialog's `submit`, keeping it open on failure. */
  async submitPassword(value: PasswordDialogValue): Promise<void> {
    const req = this.request();
    if (!req || req.kind !== 'password' || this.busy()) return;

    this.busy.set(true);
    this.inlineError.set(null);
    try {
      const error = await req.submit(value);
      if (error) {
        this.inlineError.set(error);
        return;
      }
      this.request.set(null);
      req.resolve(true);
    } finally {
      this.busy.set(false);
    }
  }

  /** Show an inline error without running `submit` — for client-side validation. */
  setInlineError(message: string): void {
    this.inlineError.set(message);
  }

  confirmAction(value?: string): void {
    const req = this.request();
    if (!req) return;
    // `password` closes only through submitPassword, which has to await
    // validation first.
    if (req.kind === 'password') return;

    this.request.set(null);
    if (req.kind === 'confirm') req.resolve(true);
    else if (req.kind === 'prompt') req.resolve(value ?? '');
    else req.resolve();
  }

  cancel(): void {
    const req = this.request();
    if (!req) return;
    if (this.busy()) return;

    this.request.set(null);
    this.inlineError.set(null);
    if (req.kind === 'confirm') req.resolve(false);
    else if (req.kind === 'prompt') req.resolve(null);
    else if (req.kind === 'password') req.resolve(false);
    else req.resolve();
  }
}
