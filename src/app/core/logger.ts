import { attachConsole, debug, error, info, warn } from '@tauri-apps/plugin-log';
import { isTauri } from './tauri-env';

/**
 * Persists app log entries through `tauri-plugin-log` (stdout + the on-disk
 * log file), so failures — like a vault failing to open — leave a trace
 * even when nothing reaches the webview's own devtools console. Falls back
 * to plain `console.*` outside Tauri (e.g. `pnpm start`) or if the plugin
 * call itself fails.
 */
function send(level: (message: string) => Promise<void>, fallback: (message: string) => void, message: string): void {
  fallback(message);
  if (!isTauri()) return;
  void level(message).catch(() => {
    // logging must never throw into caller code
  });
}

export function logDebug(message: string): void {
  send(debug, console.debug, message);
}

export function logInfo(message: string): void {
  send(info, console.info, message);
}

export function logWarn(message: string): void {
  send(warn, console.warn, message);
}

export function logError(message: string): void {
  send(error, console.error, message);
}

/** Formats a caught value (Error, invoke() rejection, anything) into a loggable string. */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Mirrors the Rust-side log (written by `tauri-plugin-log`) into this
 * webview's devtools console, so both sides of a failure show up in one
 * place during development. No-ops outside Tauri.
 */
export function initLogging(): void {
  if (!isTauri()) return;
  void attachConsole().catch(() => {
    // devtools not available yet / plugin not ready — non-fatal
  });
}
