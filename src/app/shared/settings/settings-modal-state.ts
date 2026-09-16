import { Injectable, signal } from '@angular/core';

export type SettingsCategoryId =
  | 'general'
  | 'appearance'
  | 'editor'
  | 'sidebar'
  | 'files'
  | 'encryption'
  | 'shortcuts'
  | 'advanced'
  | 'about';

const DEFAULT_CATEGORY: SettingsCategoryId = 'general';

/**
 * Drives the single Settings modal, rendered once at the layout root (see
 * `Dialog`/`DialogState` for the same pattern). Unlike `DialogState`, nothing
 * awaits a result here, so this is just open/closed plus which category is
 * showing.
 */
@Injectable({ providedIn: 'root' })
export class SettingsModalState {
  readonly isOpen = signal(false);
  // Deliberately not reset on close, so reopening the modal lands back on
  // whatever category the user was last looking at.
  readonly category = signal<SettingsCategoryId>(DEFAULT_CATEGORY);

  open(category?: SettingsCategoryId): void {
    if (category) this.category.set(category);
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }

  selectCategory(category: SettingsCategoryId): void {
    this.category.set(category);
  }
}
