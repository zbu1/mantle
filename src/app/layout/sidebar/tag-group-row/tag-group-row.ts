import { Component, DestroyRef, ElementRef, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { LucideFileText, LucideHash } from '@lucide/angular';
import { TagGroup } from '../../../notes/tags';
import { TagsState } from '../../../notes/tags-state';
import { VaultNoteNode } from '../../../notes/vault-tree.model';
import { SidebarItemButton } from '../sidebar-item-button/sidebar-item-button';
import { ExplorerRow } from '../explorer-row/explorer-row';
import { ExplorerBody } from '../explorer-body/explorer-body';

/** How long a revealed tag stays highlighted. */
const REVEAL_FLASH_MS = 1400;

/** One row in the Tags section: a tag and its note count, expandable to list its notes. */
@Component({
  selector: 'app-tag-group-row',
  imports: [SidebarItemButton, ExplorerRow, ExplorerBody, LucideFileText, LucideHash],
  templateUrl: './tag-group-row.html',
  host: { class: 'contents' },
})
export class TagGroupRow {
  private readonly tagsState = inject(TagsState);

  readonly group = input.required<TagGroup>();

  readonly openNote = output<VaultNoteNode>();
  readonly openNoteInBackground = output<VaultNoteNode>();
  readonly noteContextMenu = output<{ event: MouseEvent; note: VaultNoteNode }>();
  readonly tagContextMenu = output<MouseEvent>();

  private readonly row = viewChild.required<ElementRef<HTMLElement>>('row');

  protected readonly expanded = signal(false);
  /** Briefly true after the tag is revealed, e.g. by clicking its chip in the editor. */
  protected readonly flashing = signal(false);

  constructor() {
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    inject(DestroyRef).onDestroy(() => clearTimeout(flashTimer));

    // Consumed here rather than by the sidebar, because only the row knows
    // where it is on screen. The sidebar just makes sure the row exists.
    effect(() => {
      const request = this.tagsState.revealRequest();
      if (!request || request.key !== this.group().key) return;
      untracked(() => {
        this.tagsState.revealRequest.set(null);
        this.expanded.set(true);
        this.flashing.set(true);
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => this.flashing.set(false), REVEAL_FLASH_MS);
        // After the expansion renders, so the notes list is in view too.
        setTimeout(() => this.row().nativeElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      });
    });
  }

  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }
}
