import { Component, input, output, signal } from '@angular/core';
import { LucideFileText } from '@lucide/angular';
import { MockNote, TagGroup } from '../../../notes/notes-data';
import { SidebarItemButton } from '../sidebar-item-button/sidebar-item-button';
import { ExplorerRow } from '../explorer-row/explorer-row';
import { ExplorerBody } from '../explorer-body/explorer-body';

/** One row in the Tags section: a tag's color dot and name, expandable to list its notes. */
@Component({
  selector: 'app-tag-group-row',
  imports: [SidebarItemButton, ExplorerRow, ExplorerBody, LucideFileText],
  templateUrl: './tag-group-row.html',
  host: { class: 'contents' },
})
export class TagGroupRow {
  readonly group = input.required<TagGroup>();

  readonly openNote = output<MockNote>();
  readonly openNoteInBackground = output<MockNote>();
  readonly noteContextMenu = output<{ event: MouseEvent; note: MockNote }>();

  protected readonly expanded = signal(true);

  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }
}
