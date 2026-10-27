import { Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { Header } from '../header/header';
import { IconRail } from '../icon-rail/icon-rail';
import { Sidebar } from '../sidebar/sidebar';
import { PaneLayout } from '../pane-layout/pane-layout';
import { TabsState } from '../../notes/tabs-state';
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
import { MarkdownExportModal } from '../../notes/markdown-export/markdown-export-modal';
import { VaultRootState } from '../../notes/vault-root-state';
import { VaultState } from '../../notes/vault-state';
import { ZoomState } from '../../shared/zoom-state';
import { FolderPicker } from '../../shared/folder-picker/folder-picker';
import { isMobile } from '../../core/tauri-env';
import { MobileShell } from '../mobile-shell/mobile-shell';

@Component({
  selector: 'app-main-layout',
  imports: [
    Header,
    IconRail,
    Sidebar,
    PaneLayout,
    Welcome,
    ContextMenu,
    Dialog,
    NewEncryptedNote,
    NoteEncryptionModal,
    MarkdownExportModal,
    SettingsModal,
    VaultDragPreview,
    QuickSwitcher,
    CommandPalette,
    EncryptionPanel,
    HoverTooltipHost,
    FolderPicker,
    MobileShell,
  ],
  templateUrl: './main-layout.html',
})
export class MainLayout {
  protected readonly vaultRoot = inject(VaultRootState);
  protected readonly vaultState = inject(VaultState);
  protected readonly tabsState = inject(TabsState);
  protected readonly isMobile = isMobile;
  private readonly hoverTooltipState = inject(HoverTooltipState);
  // Created here so the saved zoom applies, and its shortcuts work, from startup.
  private readonly zoom = inject(ZoomState);
  // Only rendered while a vault is open — the welcome screen replaces it otherwise.
  private readonly editorBoundary = viewChild<ElementRef<HTMLElement>>('editorBoundary');

  constructor() {
    effect(() => {
      const boundary = this.editorBoundary();
      if (boundary) this.hoverTooltipState.registerEditorBoundary(boundary.nativeElement);
    });
  }
}
