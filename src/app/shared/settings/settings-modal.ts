import { SpellcheckState } from '../../notes/editor/spellcheck-state';
import { isMobile } from '../../core/tauri-env';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { appLogDir, join } from '@tauri-apps/api/path';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  LucideLock,
  LucideLockOpen,
  LucideSearch,
  LucideSettings,
  LucideSettings2,
} from '@lucide/angular';
import { DialogState } from '../dialog/dialog-state';
import { Toggle } from '../toggle/toggle';
import { Window } from '../window/window';
import { ProfileSettingsPanel } from './profile-settings-panel';
import { SettingsRow } from './settings-row';
import { SettingsCategoryId, SettingsModalState } from './settings-modal-state';
import { ZoomState } from '../zoom-state';
import { VaultMetaState } from '../../notes/vault-meta-state';
import { CredentialsState } from '../../notes/credentials-state';
import { VaultState, vaultNameFromPath } from '../../notes/vault-state';
import { SectionId, SidebarState } from '../../layout/sidebar/sidebar-state';

interface CategoryDef {
  id: SettingsCategoryId;
  label: string;
}

const CATEGORIES: CategoryDef[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'editor', label: 'Editor' },
  { id: 'sidebar', label: 'Sidebar & Navigation' },
  { id: 'files', label: 'Files & Vault' },
  { id: 'encryption', label: 'Encryption & Privacy' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'about', label: 'About' },
];

type DefaultNoteLocation = 'root' | 'current';
type ThemeMode = 'system' | 'light' | 'dark';
type InterfaceTextSize = 'sm' | 'md' | 'lg';
type EditorFont = 'default' | 'serif' | 'mono';
type AutosaveDelay = 'immediate' | '1s' | '3s' | '5s';
type TabBehavior = 'spaces' | 'indent';
type DeletedFileHandling = 'trash' | 'local-trash' | 'permanent';
type AutoLockTimeout = 'never' | '5m' | '15m' | '1h';

const ACCENT_SWATCHES = ['#396cd8', '#16a34a', '#d97706', '#dc2626', '#a7754e', '#6b7280'];

interface ShortcutEntry {
  action: string;
  keys: string;
}

const SHORTCUTS: ShortcutEntry[] = [
  { action: 'Close menu or dialog', keys: 'Esc' },
  { action: 'Go to note', keys: 'Ctrl+P' },
  { action: 'Command palette', keys: 'Ctrl+Shift+P' },
  { action: 'New note', keys: 'Ctrl+N' },
  { action: 'New tab', keys: 'Ctrl+T' },
  { action: 'Save note', keys: 'Ctrl+S' },
  { action: 'Save all', keys: 'Ctrl+Shift+S' },
  { action: 'Close tab', keys: 'Ctrl+W' },
  { action: 'Toggle favorite', keys: 'Ctrl+Shift+B' },
  { action: 'Undo', keys: 'Ctrl+Z' },
  { action: 'Redo', keys: 'Ctrl+Y' },
  { action: 'Select all (in the vault tree: a folder\'s items)', keys: 'Ctrl+A' },
  { action: 'Bold', keys: 'Ctrl+B' },
  { action: 'Italic', keys: 'Ctrl+I' },
  { action: 'Strikethrough', keys: 'Ctrl+Shift+X' },
  { action: 'Highlight', keys: 'Ctrl+Shift+H' },
  { action: 'Inline code', keys: 'Ctrl+`' },
  { action: 'Open link', keys: 'Ctrl+Click' },
  { action: 'Zoom in', keys: 'Ctrl+=' },
  { action: 'Zoom out', keys: 'Ctrl+-' },
  { action: 'Reset zoom', keys: 'Ctrl+0' },
  { action: 'Navigate slash menu', keys: '↑ / ↓' },
  { action: 'Confirm slash menu item', keys: 'Enter' },
];

/**
 * The Settings window: a draggable, minimizable `Window` with a category list
 * on the left and that category's rows on the right. Rendered once at the
 * layout root, like `Dialog`/`ContextMenu`.
 *
 * Most rows here are cosmetic — bound to plain local signals with a comment
 * explaining what's missing to wire them up for real — because most of the
 * settings a finished note-taking app needs (theme override, autosave
 * interval, hotkey remapping, ...) don't have any underlying mechanism in
 * Mantle yet. Rows marked [real] in a comment call an already-real service
 * directly instead.
 */
@Component({
  selector: 'app-settings-modal',
  imports: [Window, ProfileSettingsPanel, SettingsRow, Toggle, LucideLock, LucideLockOpen, LucideSettings, LucideSettings2, LucideSearch],
  templateUrl: './settings-modal.html',
})
export class SettingsModal {
  protected readonly isMobile = isMobile;
  protected readonly state = inject(SettingsModalState);
  protected readonly sidebarState = inject(SidebarState);
  protected readonly vaultState = inject(VaultState);
  protected readonly credentialsState = inject(CredentialsState);
  private readonly dialogState = inject(DialogState);
  protected readonly zoom = inject(ZoomState);
  protected readonly vaultMeta = inject(VaultMetaState);

  protected readonly categories = CATEGORIES;
  /** The profile selected in the sidebar, if it still exists. */
  protected readonly selectedProfile = computed(() => this.credentialsState.profileById(this.state.profileId()));
  protected readonly shortcuts = SHORTCUTS;
  protected readonly accentSwatches = ACCENT_SWATCHES;

  protected readonly recentVaultRows = computed(() => {
    const currentPath = this.vaultState.rootPath();
    return this.vaultState.recentVaults().map((path) => ({
      path,
      name: vaultNameFromPath(path),
      active: path === currentPath,
    }));
  });

  // ---- General ----
  // Vault path restore from localStorage already happens unconditionally in
  // VaultState today; this would need to become the thing that gates it.
  protected readonly reopenLastVault = signal(true);
  protected readonly defaultNoteLocation = signal<DefaultNoteLocation>('root');
  protected readonly defaultNoteTitle = signal('Untitled');
  protected readonly confirmBeforeDelete = signal(true);

  // ---- Appearance ----
  // No manual theme override exists — theme is 100% OS
  // `prefers-color-scheme`-driven today (see src/styles/theme.css). Wiring
  // this for real means restructuring that file to a class/attribute
  // strategy, not just adding this control.
  protected readonly themeMode = signal<ThemeMode>('system');
  protected readonly accentColor = signal(ACCENT_SWATCHES[0]);
  protected readonly interfaceTextSize = signal<InterfaceTextSize>('md');
  protected readonly editorFont = signal<EditorFont>('default');
  protected readonly editorFontSize = signal(16);
  // Mirrors vault-header.ts's own `showExtensions` stub — that one is
  // local to that component too, so this is a separate signal, not shared
  // state.
  protected readonly compactSpacing = signal(false);

  // ---- Editor ----
  // NotesState debounces saves by a fixed ~1s today; making that
  // configurable is new work.
  protected readonly autosaveDelay = signal<AutosaveDelay>('1s');
  protected readonly spellcheck = inject(SpellcheckState).enabled;
  protected readonly lineWrap = signal(true);
  protected readonly readableLineLength = signal(true);
  protected readonly typewriterScrolling = signal(false);
  protected readonly smartLists = signal(true);
  protected readonly tabBehavior = signal<TabBehavior>('spaces');

  // ---- Sidebar & Navigation ----
  // Section visibility and sidebar width below are [real] — SidebarState.
  // Sort order mirrors vault-header.ts's own SortMode stub: cosmetic
  // there too, no tree ordering is wired to it yet.
  protected readonly autoExpandActiveFolder = signal(false);

  // ---- Files & Vault ----
  protected readonly defaultAttachmentFolder = signal('attachments/');
  // A vault watcher already runs unconditionally; this would need to become
  // the thing that gates it.
  protected readonly watchExternalChanges = signal(true);
  protected readonly deletedFileHandling = signal<DeletedFileHandling>('trash');

  // ---- Encryption & Privacy ----
  // Profile list, create/lock/unlock below are [real] — CredentialsState.
  protected readonly autoLockTimeout = signal<AutoLockTimeout>('never');
  protected readonly lockOnBlur = signal(false);
  protected readonly clearClipboardAfterCopy = signal(false);

  // ---- Keyboard Shortcuts ----
  protected readonly shortcutSearch = signal('');
  protected readonly filteredShortcuts = computed(() => {
    const query = this.shortcutSearch().trim().toLowerCase();
    if (!query) return this.shortcuts;
    return this.shortcuts.filter(
      (s) => s.action.toLowerCase().includes(query) || s.keys.toLowerCase().includes(query),
    );
  });

  // ---- Advanced ----
  protected readonly hardwareAcceleration = signal(true);

  constructor() {
    // A selected profile can vanish under the window: deleted from its own
    // panel, or the vault switched. Land on the profile list rather than an
    // empty pane.
    effect(() => {
      if (!this.state.isOpen()) return;
      const id = this.state.profileId();
      if (id !== null && !this.credentialsState.profileById(id)) this.state.selectCategory('encryption');
    });
  }

  protected toggleSidebarSection(id: SectionId): void {
    this.sidebarState.toggleSection(id);
  }

  protected resetSidebarWidth(): void {
    this.sidebarState.setWidth(240);
  }

  protected async switchVault(path: string): Promise<void> {
    await this.vaultState.switchVault(path);
  }

  protected clearRecentVaults(): void {
    this.vaultState.recentVaults.set([]);
  }

  protected async revealVault(): Promise<void> {
    await this.vaultState.revealInFileExplorer('');
  }

  /** Shows the log file (`mantle.log`, named in `lib.rs`) in the file manager. */
  protected async openLogFolder(): Promise<void> {
    await revealItemInDir(await join(await appLogDir(), 'mantle.log'));
  }

  protected async revealMantleFolder(): Promise<void> {
    await this.vaultState.revealInFileExplorer('.mantle');
  }

  protected async lockProfile(profileId: string): Promise<void> {
    await this.credentialsState.lock(profileId);
  }

  protected async unlockProfile(profileId: string): Promise<void> {
    await this.credentialsState.promptUnlock(profileId);
  }

  protected async createProfile(): Promise<void> {
    await this.credentialsState.promptCreate();
  }

  protected async lockAllProfiles(): Promise<void> {
    await this.credentialsState.lockAll();
  }

  protected openProfileSettings(profileId: string): void {
    this.state.selectProfile(profileId);
  }

  protected stepEditorFontSize(delta: number): void {
    this.editorFontSize.update((v) => Math.min(24, Math.max(12, v + delta)));
  }

  /**
   * Resets the cosmetic-only signals above to their defaults. Behind a real
   * confirm dialog, but there's nothing persisted to actually clear yet —
   * that's a step to take together with wiring each setting for real, not
   * before.
   */
  protected async resetAllSettings(): Promise<void> {
    const confirmed = await this.dialogState.confirm(
      'This resets every setting on this page back to its default value.',
      { title: 'Reset All Settings', tone: 'warning', confirmLabel: 'Reset' },
    );
    if (!confirmed) return;

    this.reopenLastVault.set(true);
    this.defaultNoteLocation.set('root');
    this.defaultNoteTitle.set('Untitled');
    this.confirmBeforeDelete.set(true);
    this.themeMode.set('system');
    this.accentColor.set(ACCENT_SWATCHES[0]);
    this.interfaceTextSize.set('md');
    this.editorFont.set('default');
    this.editorFontSize.set(16);
    this.compactSpacing.set(false);
    this.autosaveDelay.set('1s');
    this.spellcheck.set(true);
    this.lineWrap.set(true);
    this.readableLineLength.set(true);
    this.typewriterScrolling.set(false);
    this.smartLists.set(true);
    this.tabBehavior.set('spaces');
    this.autoExpandActiveFolder.set(false);
    this.defaultAttachmentFolder.set('attachments/');
    this.watchExternalChanges.set(true);
    this.deletedFileHandling.set('trash');
    this.autoLockTimeout.set('never');
    this.lockOnBlur.set(false);
    this.clearClipboardAfterCopy.set(false);
    this.hardwareAcceleration.set(true);
    this.zoom.reset();
  }
}
