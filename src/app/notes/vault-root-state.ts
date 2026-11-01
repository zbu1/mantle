import { Injectable, computed, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

/** Mirrors `VaultSession` in the backend, which owns the open vault and the recents. */
export interface VaultSession {
  active: string | null;
  recents: string[];
}

/**
 * The open vault's root path, for display: the backend is what knows it and
 * what every command acts on. Loaded once at startup (`provideAppInitializer`).
 *
 * Split out of `VaultState` so lower-level state (e.g. `TabsState`, which
 * `VaultState` itself depends on) can tell whether a vault is open.
 */
@Injectable({ providedIn: 'root' })
export class VaultRootState {
  readonly path = signal<string | null>(null);
  readonly isOpen = computed(() => !!this.path());
  /** Most-recently-opened vault paths, newest first. */
  readonly recents = signal<string[]>([]);

  /** Mirrors the backend's session; also how the recents refresh after it changes them. */
  async load(): Promise<void> {
    try {
      const session = await invoke<VaultSession>('vault_session');
      this.path.set(session.active);
      this.recents.set(session.recents);
    } catch {
      // not running under Tauri — no vault
    }
  }
}
