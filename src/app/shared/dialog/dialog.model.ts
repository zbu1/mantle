export type DialogTone = 'default' | 'warning' | 'error';

interface DialogRequestBase {
  title: string;
  message: string;
  tone: DialogTone;
  confirmLabel: string;
}

export interface ConfirmDialogRequest extends DialogRequestBase {
  kind: 'confirm';
  cancelLabel: string;
  resolve: (confirmed: boolean) => void;
}

export interface AlertDialogRequest extends DialogRequestBase {
  kind: 'alert';
  resolve: () => void;
}

export interface PromptDialogRequest extends DialogRequestBase {
  kind: 'prompt';
  cancelLabel: string;
  placeholder: string;
  initialValue: string;
  /** Called with the typed value, or null if the dialog was cancelled. */
  resolve: (value: string | null) => void;
}

export interface PasswordDialogValue {
  /** Only meaningful when the request set `nameLabel`; empty string otherwise. */
  name: string;
  password: string;
}

/**
 * A password entry dialog, optionally with a name field above it (for creating
 * a profile) and a confirmation field below it.
 *
 * Unlike the other kinds, this one validates through a `submit` callback
 * rather than resolving with the typed value. A wrong password has to show its
 * error *inside the still-open dialog*: resolving would force the caller to
 * close and reopen, losing what the user typed and flashing the modal for
 * something as ordinary as a typo.
 */
export interface PasswordDialogRequest extends DialogRequestBase {
  kind: 'password';
  cancelLabel: string;
  /** Label for a name field rendered above the password, or null for none. */
  nameLabel: string | null;
  /** Whether to render and validate a "confirm password" field. */
  requireConfirm: boolean;
  /** Return an error to keep the dialog open with that message, or null to close. */
  submit: (value: PasswordDialogValue) => Promise<string | null>;
  /** Resolves true if `submit` succeeded, false if the dialog was cancelled. */
  resolve: (submitted: boolean) => void;
}

export type DialogRequest =
  | ConfirmDialogRequest
  | AlertDialogRequest
  | PromptDialogRequest
  | PasswordDialogRequest;
