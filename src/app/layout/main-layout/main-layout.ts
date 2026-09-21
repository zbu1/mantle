import { AfterViewInit, Component, ElementRef, inject, viewChild } from '@angular/core';
import { Header } from '../header/header';
import { IconRail } from '../icon-rail/icon-rail';
import { Sidebar } from '../sidebar/sidebar';
import { ContentArea } from '../content/content-area/content-area';
import { CommandPalette } from '../../shared/command-palette/command-palette';
import { ContextMenu } from '../../shared/context-menu/context-menu';
import { Dialog } from '../../shared/dialog/dialog';
import { QuickSwitcher } from '../../shared/quick-switcher/quick-switcher';
import { SettingsModal } from '../../shared/settings/settings-modal';
import { VaultDragPreview } from '../../shared/vault-drag-preview/vault-drag-preview';
import { HoverTooltipHost } from '../../shared/hover-tooltip/hover-tooltip-host';
import { HoverTooltipState } from '../../shared/hover-tooltip/hover-tooltip-state';
import { EncryptionPanel } from '../../notes/encryption-panel/encryption-panel';

@Component({
  selector: 'app-main-layout',
  imports: [
    Header,
    IconRail,
    Sidebar,
    ContentArea,
    ContextMenu,
    Dialog,
    SettingsModal,
    VaultDragPreview,
    QuickSwitcher,
    CommandPalette,
    EncryptionPanel,
    HoverTooltipHost,
  ],
  templateUrl: './main-layout.html',
})
export class MainLayout implements AfterViewInit {
  private readonly hoverTooltipState = inject(HoverTooltipState);
  private readonly editorBoundary = viewChild.required<ElementRef<HTMLElement>>('editorBoundary');

  ngAfterViewInit(): void {
    this.hoverTooltipState.registerEditorBoundary(this.editorBoundary().nativeElement);
  }
}
