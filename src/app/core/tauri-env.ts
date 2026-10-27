/** True when running inside a Tauri webview (the IPC bridge is present). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * True in the Android app, where the mobile shell (`MobileShell`) replaces the
 * desktop window chrome. Also sets the `mobile:` Tailwind variant (see `main.ts`).
 */
export const isMobile = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

/** `window.MantleAndroid`, added by `MainActivity.kt`. */
interface AndroidBridge {
  hasFilesAccess(): boolean;
  requestFilesAccess(): void;
  /** The shared storage root, e.g. `/storage/emulated/0`. */
  storageRoot(): string;
  moveToBack(): void;
}

/** The Android app's native bridge; undefined anywhere else. */
export function androidBridge(): AndroidBridge | undefined {
  return (globalThis as { MantleAndroid?: AndroidBridge }).MantleAndroid;
}
