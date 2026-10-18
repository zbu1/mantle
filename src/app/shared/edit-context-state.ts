import { Injectable, inject, signal } from '@angular/core';
import { selectAll } from 'prosemirror-commands';
import { redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import { EditorView } from 'prosemirror-view';
import { formatError, logError } from '../core/logger';
import { VaultHistoryState } from '../notes/vault-history-state';

export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

/** The Edit commands the vault tree has: the clipboard ones and Select All. */
export type TreeEditCommand = Exclude<EditCommand, 'undo' | 'redo'>;

export interface TreeEditCommands {
  can(command: TreeEditCommand): boolean;
  run(command: TreeEditCommand): void;
}

/**
 * Where the Edit menu's commands land: the note editor or the vault tree,
 * whichever last had focus. Opening a menu moves focus to it, so this
 * remembers the last place that wasn't a button; focus going to some other
 * field (the tree filter, a dialog) leaves nothing to act on. Undo and redo
 * outside the editor act on the vault's history instead.
 */
@Injectable({ providedIn: 'root' })
export class EditContextState {
  readonly context = signal<'editor' | 'tree' | null>(null);
  private editor: EditorView | null = null;
  private tree: TreeEditCommands | null = null;
  private readonly history = inject(VaultHistoryState);

  constructor() {
    // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y outside the editor and text fields, which have their own.
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const command = key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' && !event.shiftKey ? 'redo' : null;
      const target = event.target as HTMLElement;
      if (!command || target.closest?.('.ProseMirror, input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      void (command === 'undo' ? this.history.undo() : this.history.redo());
    });

    document.addEventListener('focusin', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.ProseMirror')) return; // the editor reports itself, with its view
      if (target.closest('[data-vault-tree]')) this.context.set('tree');
      // A checkbox has no undo of its own; the note properties panel claims it for its editor.
      else if (target.matches('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]')) this.context.set(null);
    });
  }

  /** The editor `view` took focus. */
  focusEditor(view: EditorView): void {
    this.editor = view;
    this.context.set('editor');
  }

  /** The editor `view` is going away. */
  forgetEditor(view: EditorView): void {
    if (this.editor !== view) return;
    this.editor = null;
    if (this.context() === 'editor') this.context.set(null);
  }

  registerTree(commands: TreeEditCommands): void {
    this.tree = commands;
  }

  canRun(command: EditCommand): boolean {
    const context = this.context();
    if (context === 'editor' && this.editor) {
      const { state } = this.editor;
      if (command === 'undo') return undoDepth(state) > 0;
      if (command === 'redo') return redoDepth(state) > 0;
      if (command === 'cut' || command === 'copy') return !state.selection.empty;
      return true;
    }
    if (command === 'undo') return this.history.canUndo();
    if (command === 'redo') return this.history.canRedo();
    return context === 'tree' && !!this.tree && this.tree.can(command);
  }

  run(command: EditCommand): void {
    if (!this.canRun(command)) return;
    if (this.context() !== 'editor' || !this.editor) {
      if (command === 'undo') void this.history.undo();
      else if (command === 'redo') void this.history.redo();
      else this.tree!.run(command);
      return;
    }
    const view = this.editor!;
    view.focus();
    switch (command) {
      case 'undo':
        undo(view.state, view.dispatch);
        break;
      case 'redo':
        redo(view.state, view.dispatch);
        break;
      case 'selectAll':
        selectAll(view.state, view.dispatch);
        break;
      case 'paste':
        // The webview won't paste through execCommand; read the clipboard and hand it to the editor.
        navigator.clipboard
          .readText()
          .then((text) => text && view.pasteText(text))
          .catch((err) => logError(`Failed to paste: ${formatError(err)}`));
        break;
      default:
        // Goes through the editor's own copy/cut handling.
        document.execCommand(command);
    }
  }
}
