/** True when running inside a Tauri webview (the IPC bridge is present). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
