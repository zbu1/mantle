import { Component } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

@Component({
  selector: 'app-header',
  imports: [],
  templateUrl: './header.html',
})
export class Header {
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
