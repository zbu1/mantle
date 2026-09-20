import { Injectable, signal } from '@angular/core';

/**
 * Drives the single credential profile settings page, rendered once at the
 * layout root (see `SettingsModalState` for the same pattern). Which profile
 * it's showing is carried here rather than as a component input, since both
 * entry points (the sidebar's per-profile menu and the Settings modal's
 * per-row button) open it from outside the page itself.
 */
@Injectable({ providedIn: 'root' })
export class ProfileSettingsPageState {
  readonly isOpen = signal(false);
  readonly profileId = signal<string | null>(null);

  open(profileId: string): void {
    this.profileId.set(profileId);
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }
}
