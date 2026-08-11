/**
 * Tauri's JS API talks to the native shell through globals that only the real
 * Tauri webview injects (`__TAURI_INTERNALS__` and friends). Under jsdom they
 * are missing, so anything that touches the API — `getCurrentWindow()` in the
 * Header, and therefore every component that renders a Header — throws while
 * being constructed. Installing this stub keeps those components testable.
 */

/** Resolved values for commands whose callers expect a meaningful result. */
const DEFAULT_RESULTS: Readonly<Record<string, unknown>> = {
  'plugin:window|is_maximized': false,
  'plugin:window|is_minimized': false,
  'plugin:window|is_fullscreen': false,
  'plugin:window|is_focused': true,
  'plugin:window|scale_factor': 1,
  // Event ids are opaque to the frontend; listen() just hands it back to unlisten().
  'plugin:event|listen': 1,
};

export interface TauriMock {
  /** Records every command sent to the backend. Commands not listed in
   * DEFAULT_RESULTS resolve with `undefined` unless overridden. */
  readonly invoke: jest.Mock;
  /** Makes `command` resolve with `value` for the rest of the test. */
  respondWith(command: string, value: unknown): void;
  /** Fires a callback registered via `transformCallback`, e.g. an event listener. */
  fireCallback(id: number, payload: unknown): void;
}

export function installTauriMock(): TauriMock {
  const results = new Map<string, unknown>(Object.entries(DEFAULT_RESULTS));
  const callbacks = new Map<number, (payload: unknown) => void>();
  let nextCallbackId = 0;

  const invoke = jest.fn((command: string) => Promise.resolve(results.get(command)));

  Object.assign(window, {
    __TAURI_INTERNALS__: {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
      invoke,
      transformCallback(callback: (payload: unknown) => void, once = false): number {
        const id = ++nextCallbackId;
        callbacks.set(id, (payload) => {
          if (once) callbacks.delete(id);
          callback(payload);
        });
        return id;
      },
      unregisterCallback(id: number): void {
        callbacks.delete(id);
      },
      convertFileSrc: (path: string) => path,
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener: () => { },
    },
  });

  return {
    invoke,
    respondWith: (command, value) => void results.set(command, value),
    fireCallback: (id, payload) => callbacks.get(id)?.(payload),
  };
}
