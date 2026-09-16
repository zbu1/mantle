import { Component, input, output } from '@angular/core';
import { LucideLock, LucideLockOpen, LucideTriangleAlert } from '@lucide/angular';

export type ProfileLockIconState = 'unknown' | 'confirming' | 'unlocked' | 'locked';

/**
 * The lock/unlock indicator projected into a credential profile row's
 * `explorerLabelTrailing` slot.
 *
 * Split out from `CredentialProfileRow`'s template rather than left as an
 * inline `@if`/`@else if` chain: that row also projects a sibling chain into
 * `explorerTrailing`, and two conditional chains projected side by side into
 * different `app-explorer-row` slots stopped re-rendering on updates (the
 * same content-projection quirk `ProfileActionsMenu` works around for
 * `explorerAction`). Each slot getting its own single component sidesteps it.
 */
@Component({
  selector: 'app-profile-lock-icon',
  imports: [LucideLock, LucideLockOpen, LucideTriangleAlert],
  templateUrl: './profile-lock-icon.html',
  host: { class: 'contents' },
})
export class ProfileLockIcon {
  readonly state = input.required<ProfileLockIconState>();
  readonly displayName = input.required<string>();

  readonly iconClick = output<MouseEvent>();

  protected onClick(event: MouseEvent): void {
    this.iconClick.emit(event);
  }
}
