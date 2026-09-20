import { Component, OnDestroy, computed, inject, input, output, signal } from '@angular/core';
import { LucidePlus } from '@lucide/angular';
import { CredentialsState } from '../../../notes/credentials-state';
import { NoteEncryptionActions } from '../../../notes/note-encryption-actions';
import { VaultNoteNode } from '../../../notes/vault-tree.model';
import { VaultSelectionState } from '../../../notes/vault-selection-state';
import { SidebarItemButton } from '../sidebar-item-button/sidebar-item-button';
import { ExplorerRow } from '../explorer-row/explorer-row';
import { ExplorerBody } from '../explorer-body/explorer-body';
import { ProfileActionsMenu } from './profile-actions-menu';
import { ProfileLockIcon, ProfileLockIconState } from './profile-lock-icon';
import { ProfileLockStatus } from './profile-lock-status';
import { ContextMenuState } from '../../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../../shared/context-menu/context-menu.model';
import { ProfileSettingsPageState } from '../../profile-settings-page/profile-settings-page-state';

/** How long an armed "lock?" confirmation stays up before reverting on its own. */
const LOCK_CONFIRM_TIMEOUT_MS = 4000;

/**
 * One row in the Credential Profiles section: a profile's lock status, name
 * and note count, expandable to list its notes.
 *
 * Expanding and locking are deliberately separate affordances. Clicking the
 * row only expands it — if the row itself prompted for a password, simply
 * looking at which notes a profile contains would open a modal.
 */
@Component({
  selector: 'app-credential-profile-row',
  imports: [SidebarItemButton, ExplorerRow, ExplorerBody, ProfileActionsMenu, ProfileLockIcon, ProfileLockStatus, LucidePlus],
  templateUrl: './credential-profile-row.html',
  host: { class: 'block' },
})
export class CredentialProfileRow implements OnDestroy {
  /** Profile id, or null for the group of notes with an unreadable header. */
  readonly profileId = input.required<string | null>();
  readonly displayName = input.required<string>();
  readonly notes = input.required<readonly VaultNoteNode[]>();
  readonly unlocked = input(false);
  /**
   * True for notes naming a profile this vault has no record of. They can't be
   * unlocked: without the registry entry there's no salt and no wrapped master
   * key to derive from.
   */
  readonly unknown = input(false);

  readonly openNote = output<VaultNoteNode>();
  readonly noteContextMenu = output<{ event: MouseEvent; note: VaultNoteNode }>();

  private readonly credentialsState = inject(CredentialsState);
  private readonly encryptionActions = inject(NoteEncryptionActions);
  private readonly selectionState = inject(VaultSelectionState);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly profileSettingsPageState = inject(ProfileSettingsPageState);

  protected readonly expanded = signal(false);
  protected readonly noteCount = computed(() => this.notes().length);

  /** True while the lock icon is armed, waiting for a confirming second click. */
  protected readonly confirmingLock = signal(false);
  private confirmLockTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly lockIconState = computed<ProfileLockIconState>(() => {
    if (this.unknown()) return 'unknown';
    if (this.confirmingLock()) return 'confirming';
    return this.unlocked() ? 'unlocked' : 'locked';
  });

  ngOnDestroy(): void {
    this.clearConfirmLockTimer();
  }

  protected toggleExpanded(): void {
    if (this.confirmingLock()) this.disarmLockConfirm();
    this.expanded.update((v) => !v);
  }

  protected onLockIconClick(event: MouseEvent): void {
    // Without this the click also reaches the row and toggles expansion.
    event.stopPropagation();

    if (this.unlocked()) {
      if (this.confirmingLock()) void this.confirmLock();
      else this.armLockConfirm();
      return;
    }

    void this.toggleLock();
  }

  protected onCancelLock(event: MouseEvent): void {
    event.stopPropagation();
    this.disarmLockConfirm();
  }

  private armLockConfirm(): void {
    this.clearConfirmLockTimer();
    this.confirmingLock.set(true);
    this.confirmLockTimer = setTimeout(() => this.disarmLockConfirm(), LOCK_CONFIRM_TIMEOUT_MS);
  }

  private disarmLockConfirm(): void {
    this.clearConfirmLockTimer();
    this.confirmingLock.set(false);
  }

  private clearConfirmLockTimer(): void {
    if (this.confirmLockTimer !== null) {
      clearTimeout(this.confirmLockTimer);
      this.confirmLockTimer = null;
    }
  }

  private async confirmLock(): Promise<void> {
    this.disarmLockConfirm();
    const id = this.profileId();
    if (id === null) return;
    await this.credentialsState.lock(id);
  }

  private async toggleLock(): Promise<void> {
    const id = this.profileId();
    if (id === null) return;

    if (this.unlocked()) await this.credentialsState.lock(id);
    else await this.credentialsState.promptUnlock(id);
  }

  protected onMenuToggleLock(): void {
    void this.toggleLock();
  }

  protected onMenuSettings(): void {
    const id = this.profileId();
    if (id !== null) this.profileSettingsPageState.open(id);
  }

  protected onMenuChangePassword(): void {
    const id = this.profileId();
    if (id !== null) void this.credentialsState.promptChangePassword(id);
  }

  protected onNoteClick(note: VaultNoteNode): void {
    if (this.unknown()) return;
    // Opens the note even while its profile is locked — the content area
    // shows a "this note is locked" screen with its own unlock affordance
    // rather than prompting for a password immediately.
    this.openNote.emit(note);
  }

  protected onNoteContextMenu(note: VaultNoteNode, event: MouseEvent): void {
    if (!this.selectionState.isSelected(note.relPath)) {
      this.selectionState.selectOnly(note.relPath);
    }
    this.noteContextMenu.emit({ event, note });
  }

  protected onHeaderContextMenu(event: MouseEvent): void {
    const items: ContextMenuItem[] = [];

    if (!this.unknown()) {
      items.push({ kind: 'item', label: 'New Note', icon: 'new-note', action: () => void this.onNewNote() });
      items.push({ kind: 'separator' });
      items.push({
        kind: 'item',
        label: this.unlocked() ? 'Lock' : 'Unlock',
        icon: this.unlocked() ? 'lock' : 'unlock',
        action: () => void this.toggleLock(),
      });
      items.push({ kind: 'separator' });
    }

    items.push({
      kind: 'item',
      label: 'New Profile…',
      icon: 'new-profile',
      action: () => void this.credentialsState.promptCreate(),
    });

    this.contextMenuState.open(event, items);
  }

  /** Create a note that is encrypted from the moment it exists. */
  protected async onNewNote(): Promise<void> {
    const id = this.profileId();
    if (id === null || this.unknown()) return;
    await this.encryptionActions.createEncryptedNote(id);
  }
}
