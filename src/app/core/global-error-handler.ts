import { ErrorHandler, Injectable } from '@angular/core';
import { formatError, logError } from './logger';

/**
 * Replaces Angular's default `ErrorHandler` so every uncaught error —
 * template errors, effects, and (via `provideBrowserGlobalErrorListeners`)
 * `window.onerror`/unhandled promise rejections — is persisted through the
 * logger instead of only ever reaching `console.error`.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    logError(`Uncaught error: ${formatError(error)}`);
  }
}
