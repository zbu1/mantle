import { Component, inject } from '@angular/core';
import { ToastState } from './toast-state';

@Component({
  selector: 'app-toast',
  template: `
    @if (toast.message(); as message) {
      <div role="status" class="animate-pop-in shadow-window pointer-events-none fixed inset-x-0 bottom-4 z-[60] mx-auto w-fit max-w-[90vw] rounded-lg bg-foreground px-4 py-2 text-sm text-background mobile:bottom-16">
        {{ message }}
      </div>
    }
  `,
})
export class Toast {
  protected readonly toast = inject(ToastState);
}
