import { Component, input, output, signal } from '@angular/core';
import { LucideChevronRight, LucideFileText, LucideFolder, LucideLock } from '@lucide/angular';
import { VaultFolderNode, VaultNode, VaultNoteNode } from '../../../notes/vault-tree.model';
import { SidebarItemButton } from '../sidebar-item-button/sidebar-item-button';

@Component({
  selector: 'app-vault-tree-node',
  imports: [SidebarItemButton, VaultTreeNode, LucideChevronRight, LucideFileText, LucideFolder, LucideLock],
  templateUrl: './vault-tree-node.html',
})
export class VaultTreeNode {
  readonly node = input.required<VaultNode>();
  readonly depth = input(0);
  readonly openLockedHint = input<string | null>(null);

  readonly openNote = output<VaultNoteNode>();
  readonly openNoteInBackground = output<VaultNoteNode>();
  readonly noteContextMenu = output<{ event: MouseEvent; note: VaultNoteNode }>();
  readonly lockedClicked = output<string>();

  protected readonly expanded = signal(true);

  protected asFolder(): VaultFolderNode | null {
    const n = this.node();
    return n.type === 'folder' ? n : null;
  }

  protected asNote(): VaultNoteNode | null {
    const n = this.node();
    return n.type === 'note' ? n : null;
  }

  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  protected onNoteClick(note: VaultNoteNode): void {
    if (note.locked) this.lockedClicked.emit(note.relPath);
    else this.openNote.emit(note);
  }
}
