import { Injectable, effect, signal } from '@angular/core';

const STORAGE_KEY = 'mantle.spellcheck';

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Whether the editor underlines misspelled words (a preference of this install, on by default). */
@Injectable({ providedIn: 'root' })
export class SpellcheckState {
  readonly enabled = signal(read());

  constructor() {
    effect(() => {
      const enabled = this.enabled();
      try {
        localStorage.setItem(STORAGE_KEY, String(enabled));
      } catch {
        // Not persisted; still applies this session.
      }
    });
  }
}
