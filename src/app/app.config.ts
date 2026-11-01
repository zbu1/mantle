import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { GlobalErrorHandler } from './core/global-error-handler';
import { VaultRootState } from './notes/vault-root-state';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // Tabs restore from the open vault, so it has to be known before anything else is built.
    provideAppInitializer(() => inject(VaultRootState).load()),
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
  ],
};
