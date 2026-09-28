import { Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { Header } from '../header/header';
import { IconRail } from '../icon-rail/icon-rail';
import { Sidebar } from '../sidebar/sidebar';
import { ContentArea } from '../content/content-area/content-area';
import { Welcome } from '../welcome/welcome';
import { CommandPalette } from '../../shared/command-palette/command-palette';
import { ContextMenu } from '../../shared/context-menu/context-menu';
import { Dialog } from '../../shared/dialog/dialog';
import { QuickSwitcher } from '../../shared/quick-switcher/quick-switcher';
import { SettingsModal } from '../../shared/settings/settings-modal';
import { VaultDragPreview } from '../../shared/vault-drag-preview/vault-drag-preview';
import { HoverTooltipHost } from '../../shared/hover-tooltip/hover-tooltip-host';
import { HoverTooltipState } from '../../shared/hover-tooltip/hover-tooltip-state';
import { EncryptionPanel } from '../../notes/encryption-panel/encryption-panel';
import { NewEncryptedNote } from '../../notes/new-encrypted-note/new-encrypted-note';
import { NoteEncryptionModal } from '../../notes/note-encryption-modal/note-encryption-modal';
import { VaultRootState } from '../../notes/vault-root-state';

@Component({
  selector: 'app-main-layout',
  imports: [
    Header,
    IconRail,
    Sidebar,
    ContentArea,
    Welcome,
    ContextMenu,
    Dialog,
    NewEncryptedNote,
    NoteEncryptionModal,
    SettingsModal,
    VaultDragPreview,
    QuickSwitcher,
    CommandPalette,
    EncryptionPanel,
    HoverTooltipHost,
  ],
  templateUrl: './main-layout.html',
})
export class MainLayout {
  protected readonly vaultRoot = inject(VaultRootState);
  private readonly hoverTooltipState = inject(HoverTooltipState);
  // Only rendered while a vault is open — the welcome screen replaces it otherwise.
  private readonly editorBoundary = viewChild<ElementRef<HTMLElement>>('editorBoundary');

  constructor() {
    effect(() => {
      const boundary = this.editorBoundary();
      if (boundary) this.hoverTooltipState.registerEditorBoundary(boundary.nativeElement);
    });
  }
}
