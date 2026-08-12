import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { EditorState, Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice } from 'prosemirror-model';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands, toggleMark } from 'prosemirror-commands';
import { splitListItem, sinkListItem, liftListItem } from 'prosemirror-schema-list';
import { undoInputRule } from 'prosemirror-inputrules';
import { gapCursor } from 'prosemirror-gapcursor';

import { NotesState } from '../notes-state';
import { schema } from './prosemirror/schema';
import { parseMarkdown, serializeMarkdown } from './prosemirror/markdown-converter';
import { createSlashMenuPlugin } from './prosemirror/plugins/slash-menu-plugin';
import { buildMarkdownInputRules } from './prosemirror/plugins/markdown-input-rules';
import { demoteEmptyLeadingBlock } from './prosemirror/commands/demote-empty-leading-block';
import { TaskItemView } from './prosemirror/nodeviews/task-item-view';

import { SlashMenu } from './slash-menu/slash-menu';
import { SlashMenuState } from './slash-menu/slash-menu-state';

function buildEditorKeymap() {
  const keys: Record<string, Command> = {
    ...baseKeymap,
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
    'Mod-b': (state, dispatch, view) => toggleMark(schema.marks['strong'])(state, dispatch, view),
    'Mod-i': (state, dispatch, view) => toggleMark(schema.marks['em'])(state, dispatch, view),
    'Mod-`': (state, dispatch, view) => toggleMark(schema.marks['code'])(state, dispatch, view),
    Enter: chainCommands(
      splitListItem(schema.nodes['list_item']),
      splitListItem(schema.nodes['task_item']),
      baseKeymap['Enter']
    ),
    Tab: chainCommands(
      sinkListItem(schema.nodes['list_item']),
      sinkListItem(schema.nodes['task_item'])
    ),
    'Shift-Tab': chainCommands(
      liftListItem(schema.nodes['list_item']),
      liftListItem(schema.nodes['task_item'])
    ),
    // undoInputRule first, so Backspace right after an auto-conversion restores
    // the literal markdown that triggered it.
    Backspace: chainCommands(undoInputRule, demoteEmptyLeadingBlock, baseKeymap['Backspace']),
  };
  return keymap(keys);
}

@Component({
  selector: 'app-note-editor',
  imports: [SlashMenu],
  templateUrl: './note-editor.html',
})
export class NoteEditor {
  private readonly notesState = inject(NotesState);
  // private readonly slashMenuState = inject(SlashMenuState);
  private readonly destroyRef = inject(DestroyRef);

  readonly noteId = input.required<string>();

  private readonly mount = viewChild.required<ElementRef<HTMLElement>>('mount');
  // private readonly slashMenuCmp = viewChild.required<SlashMenu>('slashMenu');

  private editorView: EditorView | undefined;
  private lastAppliedNoteId: string | undefined;

  protected readonly entryStatus = computed(() => this.notesState.entry(this.noteId())?.status);

  constructor() {
    afterNextRender(() => {
      const id = this.noteId();

      const state = EditorState.create({
        schema,
        doc: parseMarkdown(''),
        plugins: [
          history(),
          buildMarkdownInputRules(),
          buildEditorKeymap(),
          gapCursor(),
          // createSlashMenuPlugin(this.slashMenuState, () => this.slashMenuCmp().panelElement()),
        ],
      });

      const view = new EditorView(this.mount().nativeElement, {
        state,
        nodeViews: {
          task_item: (node, nodeView, getPos) => new TaskItemView(node, nodeView, getPos),
        },
        // Only affects plain-text pastes; HTML clipboard content still goes
        // through the default DOM parser.
        clipboardTextParser: (text) => Slice.maxOpen(parseMarkdown(text).content),
        dispatchTransaction: (tr) => {
          const newState = view.state.apply(tr);
          view.updateState(newState);

          if (tr.docChanged) {
            const markdown = serializeMarkdown(newState.doc);
            this.notesState.updateContent(this.noteId(), markdown);
          }
        },
      });

      this.editorView = view;
      this.applyIfReady(id);
    });

    effect(() => {
      const id = this.noteId();
      this.notesState.ensureLoaded(id);
      this.notesState.entry(id); // signal read so this effect reruns once loading completes
      this.applyIfReady(id);
    });

    this.destroyRef.onDestroy(() => this.editorView?.destroy());
  }

  private applyIfReady(id: string): void {
    const view = this.editorView;
    if (!view) return;
    const entry = this.notesState.entry(id);
    if (!entry || entry.status !== 'loaded' || id === this.lastAppliedNoteId) return;

    const newDoc = parseMarkdown(entry.note.content);
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc);
    view.dispatch(tr);
    this.lastAppliedNoteId = id;
  }
}
