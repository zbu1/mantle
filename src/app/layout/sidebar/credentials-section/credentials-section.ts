import { Component, computed, inject, output } from '@angular/core';
import { LucideLock } from '@lucide/angular';
import { CredentialsState } from '../../../notes/credentials-state';
import { VaultNoteNode } from '../../../notes/vault-tree.model';
import { SidebarItemButton } from '../sidebar-item-button/sidebar-item-button';
import { SidebarSection } from '../sidebar-section/sidebar-section';
import { CredentialProfileRow } from './credential-profile-row';
import { ContextMenuState } from '../../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../../shared/context-menu/context-menu.model';

/** The Credential Profiles section of the sidebar, below Tags. */
@Component({
  selector: 'app-credentials-section',
  imports: [SidebarSection, SidebarItemButton, CredentialProfileRow, LucideLock],
  templateUrl: './credentials-section.html',
  host: { class: 'contents' },
})
export class CredentialsSection {
  readonly openNote = output<VaultNoteNode>();
  readonly noteContextMenu = output<{ event: MouseEvent; note: VaultNoteNode }>();

  protected readonly credentialsState = inject(CredentialsState);
  private readonly contextMenuState = inject(ContextMenuState);

  protected readonly profiles = computed(() =>
    this.credentialsState.profiles().map((profile) => ({
      ...profile,
      notes: this.credentialsState.membersByProfile().get(profile.id) ?? [],
      hiddenCount: this.credentialsState.hiddenCountOf(profile.id),
    })),
  );

  protected readonly orphans = this.credentialsState.orphans;

  protected readonly anyUnlocked = computed(() =>
    this.credentialsState.profiles().some((p) => p.unlocked),
  );

  protected async onLockAll(): Promise<void> {
    await this.credentialsState.lockAll();
  }

  protected onBackgroundContextMenu(event: MouseEvent): void {
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'New Profile…', icon: 'new-profile', action: () => void this.credentialsState.promptCreate() },
    ];
    this.contextMenuState.open(event, items);
  }
}
