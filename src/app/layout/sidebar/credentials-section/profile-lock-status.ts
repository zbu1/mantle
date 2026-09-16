import { Component, input, output } from '@angular/core';
import { LucideX } from '@lucide/angular';

/**
 * The note count / "Lock profile?" confirmation projected into a credential
 * profile row's `explorerTrailing` slot. See `ProfileLockIcon` for why this
 * is a separate component rather than an inline chain in that row's template.
 */
@Component({
  selector: 'app-profile-lock-status',
  imports: [LucideX],
  templateUrl: './profile-lock-status.html',
  host: { class: 'contents' },
})
export class ProfileLockStatus {
  readonly confirmingLock = input(false);
  readonly noteCount = input(0);

  readonly cancel = output<MouseEvent>();

  protected onCancel(event: MouseEvent): void {
    this.cancel.emit(event);
  }
}
