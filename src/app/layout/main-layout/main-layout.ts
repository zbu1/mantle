import { Component } from '@angular/core';
import { Header } from '../header/header';
import { IconRail } from '../icon-rail/icon-rail';
import { Sidebar } from '../sidebar/sidebar';
import { ContentArea } from '../content/content-area/content-area';
import { ContextMenu } from '../../shared/context-menu/context-menu';
import { Dialog } from '../../shared/dialog/dialog';
import { SettingsModal } from '../../shared/settings/settings-modal';
import { VaultDragPreview } from '../../shared/vault-drag-preview/vault-drag-preview';

@Component({
  selector: 'app-main-layout',
  imports: [Header, IconRail, Sidebar, ContentArea, ContextMenu, Dialog, SettingsModal, VaultDragPreview],
  templateUrl: './main-layout.html',
})
export class MainLayout {}
