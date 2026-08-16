import { Component } from '@angular/core';
import { Header } from '../header/header';
import { Sidebar } from '../sidebar/sidebar';
import { ContentArea } from '../content/content-area/content-area';
import { ContextMenu } from '../../shared/context-menu/context-menu';

@Component({
  selector: 'app-main-layout',
  imports: [Header, Sidebar, ContentArea, ContextMenu],
  templateUrl: './main-layout.html',
})
export class MainLayout {}
