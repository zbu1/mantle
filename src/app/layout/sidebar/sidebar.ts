import { Component, inject, signal } from '@angular/core';
import { LucideFolderOpen, LucideFolders, LucidePlus } from '@lucide/angular';
import { SidebarSection } from './sidebar-section/sidebar-section';
import { SidebarItemButton } from './sidebar-item-button/sidebar-item-button';
import { VaultTreeNode } from './vault-tree-node/vault-tree-node';
import { SidebarState } from './sidebar-state';
import { TabsState } from '../../notes/tabs-state';
import { VaultState } from '../../notes/vault-state';
import { VaultNoteNode } from '../../notes/vault-tree.model';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../shared/context-menu/context-menu.model';

@Component({
  selector: 'app-sidebar',
  imports: [SidebarSection, SidebarItemButton, VaultTreeNode, LucideFolderOpen, LucideFolders, LucidePlus],
  templateUrl: './sidebar.html',
  host: { class: 'contents' },
})
export class Sidebar {
  protected readonly state = inject(SidebarState);
  protected readonly vaultState = inject(VaultState);
  private readonly tabsState = inject(TabsState);
  private readonly contextMenuState = inject(ContextMenuState);

  protected readonly lockedHint = signal<string | null>(null);

  private readonly dragStartX = signal<number | null>(null);
  private readonly dragStartWidth = signal<number>(0);

  protected async onOpenVault(): Promise<void> {
    await this.vaultState.pickVault();
  }

  protected async onNewNote(): Promise<void> {
    const base = 'Untitled';
    for (let i = 0; i < 50; i++) {
      const name = i === 0 ? base : `${base} ${i + 1}`;
      try {
        const created = await this.vaultState.createNote('', name);
        this.tabsState.openNote({ id: created.relPath, title: created.name });
        return;
      } catch {
        // name collision — try the next candidate
      }
    }
  }

  protected onOpenNote(note: VaultNoteNode): void {
    this.tabsState.openNote({ id: note.relPath, title: note.name });
  }

  protected onOpenNoteInBackground(note: VaultNoteNode): void {
    this.tabsState.openNoteInBackground({ id: note.relPath, title: note.name });
  }

  protected onLockedClicked(relPath: string): void {
    this.lockedHint.update((current) => (current === relPath ? null : relPath));
  }

  protected onNoteContextMenu(payload: { event: MouseEvent; note: VaultNoteNode }): void {
    const { event, note } = payload;
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Open', icon: 'open', action: () => this.onOpenNote(note) },
      { kind: 'item', label: 'Open in New Tab', icon: 'open-new-tab', action: () => this.onOpenNoteInBackground(note) },
    ];
    this.contextMenuState.open(event, items);
  }

  protected onResizePointerDown(event: PointerEvent): void {
    if (this.state.collapsed()) return;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    this.dragStartX.set(event.clientX);
    this.dragStartWidth.set(this.state.width());
  }

  protected onResizePointerMove(event: PointerEvent): void {
    const startX = this.dragStartX();
    if (startX === null) return;
    const delta = event.clientX - startX;
    this.state.setWidth(this.dragStartWidth() + delta);
  }

  protected onResizePointerUp(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    handle.releasePointerCapture(event.pointerId);
    this.dragStartX.set(null);
  }
}
