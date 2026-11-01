import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { DialogState } from '../shared/dialog/dialog-state';
import { AttachmentsState } from './attachments-state';
import { NoteLinksState } from './note-links-state';
import { NotesState, titleFromRelPath } from './notes-state';
import { focusNoteTitle } from './tab-menu';
import { TabsState } from './tabs-state';
import { VaultHistoryState, canUndoDelete } from './vault-history-state';
import { VaultMetaState } from './vault-meta-state';
import { CreatedNote, VaultState } from './vault-state';
import { VaultNode, dirOf, fileNameOf, flattenTreeNodes, flattenVaultNotes, topmostPaths } from './vault-tree.model';

type ItemKind = VaultNode['type'];

/** One item a move took from `from` to `to`. */
interface Moved {
  kind: ItemKind;
  from: string;
  to: string;
}

/** Maps a path from before `moves` to where it is after. */
const movedBy = (moves: readonly Moved[]) => (relPath: string) => {
  for (const { kind, from, to } of moves) {
    if (relPath === from) return to;
    if (kind === 'folder' && relPath.startsWith(`${from}/`)) return to + relPath.slice(from.length);
  }
  return relPath;
};

const quoted = (items: readonly { name: string }[], what: string) =>
  items.length === 1 ? `"${items[0].name}"` : `${items.length} ${what}`;

/**
 * The vault tree's structural actions (create, rename, move, duplicate,
 * copy, delete), each of which keeps open tabs, loaded notes and
 * `state.json` pointing at the right paths, and records an undo step.
 */
@Injectable({ providedIn: 'root' })
export class VaultActions {
  private readonly vaultState = inject(VaultState);
  private readonly notesState = inject(NotesState);
  private readonly tabsState = inject(TabsState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly attachments = inject(AttachmentsState);
  private readonly history = inject(VaultHistoryState);
  private readonly dialogState = inject(DialogState);
  private readonly links = inject(NoteLinksState);

  async createNote(relDir: string, name: string): Promise<CreatedNote> {
    const created = await this.vaultState.createNote(relDir, name);
    this.recordCreated('note', created, () => this.vaultState.createNote(relDir, name));
    return created;
  }

  async createAndOpenNote(relDir = ''): Promise<CreatedNote | null> {
    const created = await this.vaultState.createAndOpenNote(relDir);
    if (created) {
      this.recordCreated('note', created, () => this.vaultState.createNote(relDir, created.name));
      focusNoteTitle();
    }
    return created;
  }

  async createFolder(relDir: string, name: string): Promise<CreatedNote> {
    const created = await this.vaultState.createFolder(relDir, name);
    this.recordCreated('folder', created, () => this.vaultState.createFolder(relDir, name));
    return created;
  }

  async createFolderWithUniqueName(relDir = ''): Promise<CreatedNote> {
    const created = await this.vaultState.createFolderWithUniqueName(relDir);
    this.recordCreated('folder', created, () => this.vaultState.createFolder(relDir, created.name));
    return created;
  }

  async duplicate(relPath: string): Promise<CreatedNote> {
    const created = await this.vaultState.duplicateNote(relPath);
    this.recordCreated('note', created);
    return created;
  }

  async copy(relPath: string, destRelDir: string): Promise<CreatedNote> {
    const created = await this.vaultState.copyNote(relPath, destRelDir);
    this.recordCreated('note', created);
    return created;
  }

  /** Records undoing a creation as trashing it. `recreate` stands in for restoring it where the trash can't be. */
  recordCreated(kind: 'note' | 'folder', created: CreatedNote, recreate?: () => Promise<unknown>): void {
    const node = { type: kind, relPath: created.relPath, name: created.name, children: [] } as unknown as VaultNode;
    this.history.record({
      label: `Create "${created.name}"`,
      paths: [created.relPath],
      undo: () => this.trash([node]),
      redo: () => (canUndoDelete || !recreate ? this.restore([created.relPath]) : recreate()),
    });
  }

  async rename(kind: 'note' | 'folder', relPath: string, newName: string): Promise<string> {
    const oldName = kind === 'note' ? titleFromRelPath(relPath) : fileNameOf(relPath);
    if (kind === 'folder' && !(await this.confirmLockedHidden("won't move with it"))) return relPath;
    const renamed = await this.renameOnly(kind, relPath, newName);
    this.history.record({
      label: `Rename "${oldName}"`,
      paths: [relPath, renamed],
      undo: () => this.renameOnly(kind, renamed, oldName),
      redo: () => this.renameOnly(kind, relPath, newName),
    });
    return renamed;
  }

  private async renameOnly(kind: 'note' | 'folder', relPath: string, newName: string): Promise<string> {
    const before = this.vaultState.tree();
    const renamed =
      kind === 'note' ? await this.vaultState.renameNote(relPath, newName) : await this.vaultState.renameFolder(relPath, newName);
    this.follow(kind, relPath, renamed.relPath);
    await this.links.fixAfterMove(before, movedBy([{ kind, from: relPath, to: renamed.relPath }]), kind === 'note');
    return renamed.relPath;
  }

  /**
   * Moves tree items into `destRelDir` as one undo step, skipping any already
   * there and any folder that would land inside itself.
   */
  async move(relPaths: readonly string[], destRelDir: string): Promise<void> {
    const nodes = this.nodesByPath();
    const items = topmostPaths(relPaths).flatMap((relPath) => {
      const kind = nodes.get(relPath)?.type;
      if (!kind || dirOf(relPath) === destRelDir) return [];
      if (kind === 'folder' && (destRelDir === relPath || destRelDir.startsWith(`${relPath}/`))) return [];
      return [{ kind, relPath, destRelDir }];
    });
    if (items.some((item) => item.kind === 'folder') && !(await this.confirmLockedHidden("won't move with them"))) return;
    let moved = await this.moveEach(items);
    if (moved.length === 0) return;
    this.history.record({
      label: `Move ${quoted(moved.map((item) => ({ name: fileNameOf(item.from) })), 'items')}`,
      paths: moved.flatMap((item) => [item.from, item.to]),
      undo: async () => {
        // Moving back must land on the old path, not beside something new that took it.
        await this.vaultState.refresh();
        const taken = moved.find((item) => this.nodesByPath().has(item.from));
        if (taken) throw new Error(`"${taken.from}" already exists`);
        await this.moveEach(moved.map((item) => ({ kind: item.kind, relPath: item.to, destRelDir: dirOf(item.from) })));
      },
      redo: async () => {
        moved = await this.moveEach(moved.map((item) => ({ kind: item.kind, relPath: item.from, destRelDir: dirOf(item.to) })));
      },
    });
  }

  private async moveEach(items: readonly { kind: ItemKind; relPath: string; destRelDir: string }[]): Promise<Moved[]> {
    const before = this.vaultState.tree();
    const moved: Moved[] = [];
    try {
      await this.moveAll(items, moved);
    } finally {
      // Even a move that failed partway keeps the links of what did move.
      if (moved.some((item) => item.kind !== 'file')) await this.links.fixAfterMove(before, movedBy(moved), false);
    }
    return moved;
  }

  private async moveAll(items: readonly { kind: ItemKind; relPath: string; destRelDir: string }[], moved: Moved[]): Promise<void> {
    for (const { kind, relPath, destRelDir } of items) {
      const result =
        kind === 'note'
          ? await this.vaultState.moveNote(relPath, destRelDir)
          : kind === 'folder'
            ? await this.vaultState.moveFolder(relPath, destRelDir)
            : await this.vaultState.moveFile(relPath, destRelDir);
      this.follow(kind, relPath, result.relPath);
      moved.push({ kind, from: relPath, to: result.relPath });
    }
  }

  /**
   * Moves `items` (and `attachments`, which only they used) to the OS trash
   * as one undo step: undoing restores them from the trash.
   */
  async delete(items: readonly VaultNode[], attachments: readonly string[] = []): Promise<void> {
    const paths = items.map((item) => item.relPath);
    if (items.some((item) => item.type === 'folder') && !(await this.confirmLockedHidden("won't be deleted"))) return;
    const favorites = this.vaultMeta
      .favorites()
      .filter((relPath) => paths.some((path) => relPath === path || relPath.startsWith(`${path}/`)));
    const styles = Object.entries(this.vaultMeta.styles()).filter(([relPath]) =>
      paths.some((path) => relPath === path || relPath.startsWith(`${path}/`)),
    );
    await this.trash(items);
    await this.attachments.delete(attachments);
    if (!canUndoDelete) return;
    this.history.record({
      label: `Delete ${quoted(items, 'items')}`,
      paths,
      undo: async () => {
        await this.restore([...paths, ...attachments]);
        this.vaultMeta.addFavorites(favorites);
        for (const [relPath, style] of styles) this.vaultMeta.setStyle(relPath, style);
      },
      redo: async () => {
        await this.trash(items);
        await this.attachments.delete(attachments);
      },
    });
  }

  /** Puts trashed vault items back where they were. */
  async restore(relPaths: readonly string[]): Promise<void> {
    const vaultRoot = this.vaultState.rootPath();
    if (!vaultRoot) throw new Error('No vault is open.');
    await invoke('restore_from_trash', { vaultRoot, relPaths });
    await this.vaultState.refresh();
  }

  /** Trashes `items`, closing and forgetting everything that was in them. */
  private async trash(items: readonly VaultNode[]): Promise<void> {
    for (const item of items) {
      if (item.type === 'folder') {
        await this.vaultState.deleteFolder(item.relPath);
        // Files in it too, not just notes: their preview tabs would show nothing.
        for (const tab of this.tabsState.tabs().filter((t) => t.noteId?.startsWith(`${item.relPath}/`))) {
          this.tabsState.closeTab(tab.id);
        }
        for (const relPath of flattenVaultNotes(item).keys()) this.vaultMeta.forgetNote(relPath);
        this.vaultMeta.forgetFolder(item.relPath);
      } else {
        // `delete_note` trashes whatever path it's given, files included.
        await this.vaultState.deleteNote(item.relPath);
        this.tabsState.closeByNoteId(item.relPath);
        if (item.type === 'note') this.vaultMeta.forgetNote(item.relPath);
      }
    }
  }

  /** Points tabs, loaded notes and `state.json` at an item's new path. */
  private follow(kind: ItemKind, from: string, to: string): void {
    if (from === to) return;
    if (kind !== 'folder') {
      if (kind === 'note') {
        this.notesState.renameNoteId(from, to);
        this.vaultMeta.renameNote(from, to);
        this.vaultState.renameNoteInTree(from, to, titleFromRelPath(to));
      }
      this.tabsState.renameNoteId(from, to, kind === 'note' ? titleFromRelPath(to) : fileNameOf(to));
      return;
    }
    const inside = (path: string) => path.startsWith(`${from}/`);
    const moved = (path: string) => to + path.slice(from.length);
    this.vaultMeta.renameFolder(from, to);
    for (const id of this.notesState.ids().filter(inside)) this.notesState.renameNoteId(id, moved(id));
    for (const { noteId, title } of this.tabsState.tabs()) {
      if (noteId && inside(noteId)) this.tabsState.renameNoteId(noteId, moved(noteId), title);
    }
  }

  /**
   * Hidden notes of locked profiles may be inside a folder being renamed,
   * moved or deleted, and can't be updated: say so first. Resolves whether to
   * go ahead. On unlock they show under the old path, as a virtual folder.
   */
  private async confirmLockedHidden(outcome: string): Promise<boolean> {
    const count = Object.values(this.vaultState.lockedHidden()).reduce((sum, n) => sum + n, 0);
    if (count === 0) return true;
    return this.dialogState.confirm(
      `${count === 1 ? '1 hidden note' : `${count} hidden notes`} in locked profiles may be inside and ${outcome}. ` +
        'Unlock their profiles first to include them.',
      { title: 'Hidden Notes May Be Left Behind', tone: 'warning', confirmLabel: 'Continue' },
    );
  }

  private nodesByPath(): Map<string, VaultNode> {
    const tree = this.vaultState.tree();
    return tree ? flattenTreeNodes(tree) : new Map();
  }
}
