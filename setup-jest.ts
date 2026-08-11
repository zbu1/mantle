import { setupZonelessTestEnv } from 'jest-preset-angular/setup-env/zoneless';
import { installTauriMock } from './src/testing/tauri-mock';

setupZonelessTestEnv();

// Reinstalled per test so each one starts with a clean command log.
beforeEach(() => {
  installTauriMock();
});
