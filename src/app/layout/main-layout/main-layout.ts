import { Component } from '@angular/core';
import { Header } from '../header/header';
import { Sidebar } from '../sidebar/sidebar';
import { ContentArea } from '../content/content-area/content-area';

@Component({
  selector: 'app-main-layout',
  imports: [Header, Sidebar, ContentArea],
  templateUrl: './main-layout.html',
})
export class MainLayout {}
