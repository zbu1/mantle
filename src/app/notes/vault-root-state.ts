import { Injectable, computed, effect, signal } from '@angular/core';

const STORAGE_KEY = 'mantle.vault.v1';

function readStoredPath(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The open vault's root path, persisted across launches.
 *
 * Split out of `VaultState` so lower-level state (e.g. `TabsState`, which
 * `VaultState` itself depends on) can tell whether a vault is open.
 */
@Injectable({ providedIn: 'root' })
export class VaultRootState {
  readonly path = signal<string | null>(readStoredPath());
  readonly isOpen = computed(() => !!this.path());

  constructor() {
    effect(() => {
      const path = this.path();
      try {
        if (path) localStorage.setItem(STORAGE_KEY, path);
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        // storage unavailable (e.g. private browsing) — ignore
      }
    });
  }
}
