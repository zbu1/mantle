import { Component, inject, signal } from '@angular/core';
import {
  LucideClock,
  LucideFileText,
  LucideFolderOpen,
  LucideFolders,
  LucidePlus,
  LucideStar,
  LucideTags,
} from '@lucide/angular';
import { confirm } from '@tauri-apps/plugin-dialog';
import { join } from '@tauri-apps/api/path';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { SidebarSection } from './sidebar-section/sidebar-section';
import { SidebarItemButton } from './sidebar-item-button/sidebar-item-button';
import { VaultTreeNode } from './vault-tree-node/vault-tree-node';
import { FAVORITE_NOTES, MockNote, RECENT_NOTES, TAG_GROUPS } from '../../notes/notes-data';
import { SidebarState } from './sidebar-state';
import { TabsState } from '../../notes/tabs-state';
import { VaultState } from '../../notes/vault-state';
import { VaultClipboardState } from '../../notes/vault-clipboard-state';
import { VaultFolderNode, VaultNoteNode } from '../../notes/vault-tree.model';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../shared/context-menu/context-menu.model';

@Component({
  selector: 'app-sidebar',
  imports: [
    SidebarSection,
    SidebarItemButton,
    VaultTreeNode,
    LucideFolderOpen,
    LucideFolders,
    LucidePlus,
    LucideStar,
    LucideClock,
    LucideTags,
    LucideFileText,
  ],
  templateUrl: './sidebar.html',
  host: { class: 'contents' },
})
export class Sidebar {
  protected readonly state = inject(SidebarState);
  protected readonly vaultState = inject(VaultState);
  private readonly tabsState = inject(TabsState);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly clipboardState = inject(VaultClipboardState);

  protected readonly favorites = FAVORITE_NOTES;
  protected readonly recentFiles = RECENT_NOTES;
  protected readonly tagGroups = TAG_GROUPS;

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

  protected openNote(note: MockNote): void {
    this.tabsState.openNote(note);
  }

  protected openNoteInBackground(note: MockNote): void {
    this.tabsState.openNoteInBackground(note);
  }

  protected openNoteContextMenu(event: MouseEvent, note: MockNote): void {
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Open', icon: 'open', action: () => this.openNote(note) },
      { kind: 'item', label: 'Open in New Tab', icon: 'open-new-tab', action: () => this.openNoteInBackground(note) },
      { kind: 'separator' },
      { kind: 'item', label: 'Rename', icon: 'rename', action: () => {} },
      { kind: 'item', label: 'Duplicate', icon: 'duplicate', action: () => {} },
      {
        kind: 'item',
        label: note.favorite ? 'Remove from Favorites' : 'Add to Favorites',
        icon: note.favorite ? 'unfavorite' : 'favorite',
        action: () => {},
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Delete', icon: 'delete', danger: true, action: () => {} },
    ];
    this.contextMenuState.open(event, items);
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
      { kind: 'separator' },
      { kind: 'item', label: 'Show in File Explorer', icon: 'reveal', action: () => void this.revealRelPath(note.relPath) },
      { kind: 'separator' },
      { kind: 'item', label: 'Duplicate', icon: 'duplicate', action: () => void this.vaultState.duplicateNote(note.relPath) },
      { kind: 'item', label: 'Copy', icon: 'copy', action: () => this.clipboardState.copy(note) },
      { kind: 'item', label: 'Cut', icon: 'cut', action: () => this.clipboardState.cut(note) },
      { kind: 'separator' },
      { kind: 'item', label: 'Rename', icon: 'rename', disabled: true, action: () => {} },
      { kind: 'item', label: 'Add to Favorites', icon: 'favorite', disabled: true, action: () => {} },
      { kind: 'separator' },
      { kind: 'item', label: 'Delete', icon: 'delete', danger: true, action: () => void this.deleteNote(note) },
    ];
    this.contextMenuState.open(event, items);
  }

  protected onFolderContextMenu(payload: { event: MouseEvent; folder: VaultFolderNode }): void {
    const { event, folder } = payload;
    const items: ContextMenuItem[] = [
      {
        kind: 'item',
        label: 'Show in File Explorer',
        icon: 'reveal',
        action: () => void this.revealRelPath(folder.relPath),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Paste',
        icon: 'paste',
        disabled: !this.clipboardState.entry(),
        action: () => void this.pasteInto(folder.relPath),
      },
    ];
    this.contextMenuState.open(event, items);
  }

  protected onVaultBackgroundContextMenu(event: MouseEvent): void {
    const items: ContextMenuItem[] = [
      {
        kind: 'item',
        label: 'Paste',
        icon: 'paste',
        disabled: !this.clipboardState.entry(),
        action: () => void this.pasteInto(''),
      },
    ];
    this.contextMenuState.open(event, items);
  }

  private async revealRelPath(relPath: string): Promise<void> {
    const root = this.vaultState.rootPath();
    if (!root) return;
    const absolute = relPath ? await join(root, ...relPath.split('/')) : root;
    await revealItemInDir(absolute);
  }

  private async deleteNote(note: VaultNoteNode): Promise<void> {
    const confirmed = await confirm(`Delete "${note.name}"? This can't be undone.`, {
      title: 'Delete Note',
      kind: 'warning',
    });
    if (!confirmed) return;
    await this.vaultState.deleteNote(note.relPath);
    this.tabsState.closeByNoteId(note.relPath);
  }

  private async pasteInto(destRelDir: string): Promise<void> {
    const clip = this.clipboardState.entry();
    if (!clip) return;
    if (clip.mode === 'copy') {
      await this.vaultState.copyNote(clip.relPath, destRelDir);
    } else {
      const moved = await this.vaultState.moveNote(clip.relPath, destRelDir);
      this.tabsState.renameNoteId(clip.relPath, moved.relPath, moved.name);
      this.clipboardState.clear();
    }
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
