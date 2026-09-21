import { Injectable, computed, signal } from '@angular/core';
import { WindowModel } from '../window/window-model';

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
 * Drives the single Settings window, rendered once at the layout root (see
 * `Dialog`/`DialogState` for the same pattern). Unlike `DialogState`, nothing
 * awaits a result here, so this is just the window's open/minimized/maximized
 * state (see `WindowModel`) plus what its sidebar has selected: one of the
 * "Options" categories, or one credential profile.
 */
@Injectable({ providedIn: 'root' })
export class SettingsModalState extends WindowModel {
  // Neither selection is reset on close, so reopening the window lands back on
  // whatever the user was last looking at.
  readonly category = signal<SettingsCategoryId>(DEFAULT_CATEGORY);
  /** The selected credential profile, or `null` when a category is showing instead. */
  readonly profileId = signal<string | null>(null);

  /** The category to highlight: `null` while a profile is selected, since only one thing is. */
  readonly activeCategory = computed(() => (this.profileId() === null ? this.category() : null));

  open(category?: SettingsCategoryId): void {
    if (category) this.selectCategory(category);
    this.show();
  }

  /** Opens the window on a credential profile's settings. */
  openProfile(profileId: string): void {
    this.selectProfile(profileId);
    this.show();
  }

  selectCategory(category: SettingsCategoryId): void {
    this.category.set(category);
    this.profileId.set(null);
  }

  selectProfile(profileId: string): void {
    this.profileId.set(profileId);
  }
}
