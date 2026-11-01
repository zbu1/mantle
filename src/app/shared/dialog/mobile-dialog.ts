import { Component } from '@angular/core';
import { HelpPopover } from '../help-popover/help-popover';
import { Dialog } from './dialog';

/** `Dialog` as a bottom sheet for Android; the logic is inherited. */
@Component({
  selector: 'app-mobile-dialog',
  imports: [HelpPopover],
  templateUrl: './mobile-dialog.html',
})
export class MobileDialog extends Dialog {}
