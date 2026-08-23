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

export type DialogRequest = ConfirmDialogRequest | AlertDialogRequest;
