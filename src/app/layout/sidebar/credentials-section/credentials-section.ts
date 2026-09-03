import { Component, computed, inject, output } from '@angular/core';
import { LucideKeyRound, LucideLock, LucidePlus } from '@lucide/angular';
import { CredentialsState } from '../../../notes/credentials-state';
import { VaultNoteNode } from '../../../notes/vault-tree.model';
import { SidebarItemButton } from '../sidebar-item-button/sidebar-item-button';
import { SidebarSection } from '../sidebar-section/sidebar-section';
import { CredentialProfileRow } from './credential-profile-row';

/** The Credential Profiles section of the sidebar, below Tags. */
@Component({
  selector: 'app-credentials-section',
  imports: [SidebarSection, SidebarItemButton, CredentialProfileRow, LucideKeyRound, LucideLock, LucidePlus],
  templateUrl: './credentials-section.html',
  host: { class: 'contents' },
})
export class CredentialsSection {
  readonly openNote = output<VaultNoteNode>();

  protected readonly credentialsState = inject(CredentialsState);

  protected readonly profiles = computed(() =>
    this.credentialsState.profiles().map((profile) => ({
      ...profile,
      notes: this.credentialsState.membersByProfile().get(profile.id) ?? [],
    })),
  );

  protected readonly orphans = this.credentialsState.orphans;

  protected readonly anyUnlocked = computed(() =>
    this.credentialsState.profiles().some((p) => p.unlocked),
  );

  protected async onNewProfile(): Promise<void> {
    await this.credentialsState.promptCreate();
  }

  protected async onLockAll(): Promise<void> {
    await this.credentialsState.lockAll();
  }
}
