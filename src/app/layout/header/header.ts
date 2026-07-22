import { Component, inject } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SidebarState } from '../sidebar/sidebar-state';

@Component({
  selector: 'app-header',
  imports: [],
  templateUrl: './header.html',
})
export class Header {
  protected readonly sidebarState = inject(SidebarState);

  toggleSidebar(): void {
    this.sidebarState.toggleCollapsed();
  }

  minimize(): void {
    getCurrentWindow().minimize();
  }

  toggleMaximize(): void {
    getCurrentWindow().toggleMaximize();
  }

  close(): void {
    getCurrentWindow().close();
  }
}
