import { signal } from '@angular/core';

/**
 * The open / minimized / maximized state of one floating `Window`. Each window's
 * own state service (`SettingsModalState`) extends this, so callers keep
 * opening it through the service they already know and `Window` binds to it
 * directly.
 *
 * Position and size are not kept here — they're pure presentation and live in
 * the `Window` component.
 */
export class WindowModel {
  readonly isOpen = signal(false);
  readonly minimized = signal(false);
  readonly maximized = signal(false);
  /**
   * Bumped on every `show()`, so opening an already-open window (say, jumping
   * to another settings category from the command palette) still brings it to
   * the front and focuses it.
   */
  readonly activation = signal(0);

  /** Opens the window, restoring it first if it was minimized. */
  protected show(): void {
    this.minimized.set(false);
    this.isOpen.set(true);
    this.activation.update((n) => n + 1);
  }

  close(): void {
    this.isOpen.set(false);
    // A closed window shouldn't come back minimized. Maximized is kept, like a
    // desktop window remembering how you left it.
    this.minimized.set(false);
  }

  minimize(): void {
    this.minimized.set(true);
  }

  restore(): void {
    this.minimized.set(false);
  }

  toggleMaximized(): void {
    this.maximized.update((m) => !m);
  }
}
