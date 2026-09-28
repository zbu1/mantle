import { Injectable, effect, signal } from '@angular/core';

const STORAGE_KEY = 'mantle.markdownNoticeDismissed';

function readFromStorage(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Whether the "plain Markdown file" banner above the editor has been dismissed.
 *
 * Dismissal is global and permanent, and lives in this app install's local
 * storage rather than the vault's `.mantle/state.json`: it's a preference of
 * whoever is using this copy of Mantle, not a property of the vault. The `.md`
 * shown after the file's name in the tree remains either way.
 */
@Injectable({ providedIn: 'root' })
export class MarkdownNoticeState {
  readonly dismissed = signal(readFromStorage());

  constructor() {
    effect(() => {
      const dismissed = this.dismissed();
      try {
        if (dismissed) localStorage.setItem(STORAGE_KEY, 'true');
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        // storage unavailable (e.g. private browsing) — ignore
      }
    });
  }

  dismiss(): void {
    this.dismissed.set(true);
  }
}
