import { Injectable, effect, signal } from '@angular/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { isTauri } from '../core/tauri-env';
import { formatError, logError } from '../core/logger';

const STORAGE_KEY = 'mantle.zoom.v1';
/** Zoom levels Ctrl+= / Ctrl+- step through, like a browser's. */
const LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function readLevel(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return LEVELS.includes(stored) ? stored : 1;
  } catch {
    return 1;
  }
}

/**
 * The whole window's zoom (View › Zoom In / Out / Reset, Ctrl+= / Ctrl+- /
 * Ctrl+0), kept per app install in localStorage: it's about this screen,
 * not the vault.
 */
@Injectable({ providedIn: 'root' })
export class ZoomState {
  readonly level = signal(readLevel());

  constructor() {
    effect(() => {
      const level = this.level();
      try {
        localStorage.setItem(STORAGE_KEY, String(level));
      } catch {
        // storage unavailable: the level just won't outlive the session
      }
      if (!isTauri()) {
        document.documentElement.style.setProperty('zoom', String(level));
        return;
      }
      getCurrentWebview()
        .setZoom(level)
        .catch((err) => logError(`Failed to zoom: ${formatError(err)}`));
    });

    document.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      // `+` comes shifted on most layouts, so Shift is allowed through.
      const action = { '=': this.zoomIn, '+': this.zoomIn, '-': this.zoomOut, '0': this.reset }[event.key];
      if (!action) return;
      event.preventDefault();
      action.call(this);
    });
  }

  zoomIn(): void {
    this.level.update((level) => LEVELS.find((l) => l > level) ?? level);
  }

  zoomOut(): void {
    this.level.update((level) => [...LEVELS].reverse().find((l) => l < level) ?? level);
  }

  reset(): void {
    this.level.set(1);
  }
}
