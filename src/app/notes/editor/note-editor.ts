import { Component, DestroyRef, ElementRef, afterNextRender, effect, inject, input, untracked, viewChild } from '@angular/core';
import { Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/extension-bubble-menu';
import type { MarkdownStorage } from 'tiptap-markdown';
import { NotesState } from '../notes-state';
import { EDITOR_EXTENSIONS } from './editor-extensions';
import { BubbleMenuPanel } from './bubble-menu/bubble-menu';
import { BubbleMenuState } from './bubble-menu/bubble-menu-state';
import { SlashMenu } from './slash-menu/slash-menu';
import { SlashMenuState } from './slash-menu/slash-menu-state';
import { SlashCommand } from './slash-menu/slash-command-extension';
import { filterSlashCommands } from './slash-menu/slash-menu.model';

function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as Record<string, MarkdownStorage>)['markdown'].getMarkdown();
}

@Component({
  selector: 'app-note-editor',
  imports: [BubbleMenuPanel, SlashMenu],
  templateUrl: './note-editor.html',
})
export class NoteEditor {
  private readonly notesState = inject(NotesState);
  private readonly bubbleMenuState = inject(BubbleMenuState);
  private readonly slashMenuState = inject(SlashMenuState);
  private readonly destroyRef = inject(DestroyRef);

  readonly noteId = input.required<string>();

  private readonly mount = viewChild.required<ElementRef<HTMLElement>>('mount');
  private readonly bubbleMenuCmp = viewChild.required<BubbleMenuPanel>('bubbleMenu');
  private readonly slashMenuCmp = viewChild.required<SlashMenu>('slashMenu');

  private editor: Editor | undefined;
  private lastAppliedNoteId: string | undefined;

  constructor() {
    afterNextRender(() => {
      const id = this.noteId();
      const content = this.notesState.getNote(id)?.content ?? '';
      const bubbleMenuCmp = this.bubbleMenuCmp();
      const slashMenuCmp = this.slashMenuCmp();
      const slashMenuState = this.slashMenuState;

      const editor = new Editor({
        element: this.mount().nativeElement,
        extensions: [
          ...EDITOR_EXTENSIONS,
          BubbleMenu.configure({
            element: bubbleMenuCmp.panelElement(),
            shouldShow: ({ editor, state }) => {
              if (state.selection.empty || !editor.isEditable || editor.isActive('codeBlock')) return false;
              return true;
            },
          }),
          SlashCommand.configure({
            suggestion: {
              items: ({ query }) => filterSlashCommands(query),
              render: () => {
                let unmount: (() => void) | undefined;
                return {
                  onStart: (props) => {
                    const panel = slashMenuCmp.panelElement();
                    slashMenuState.show(props.items, (item) => props.command(item));
                    panel.style.display = '';
                    unmount = props.mount(panel);
                  },
                  onUpdate: (props) => {
                    slashMenuState.updateItems(props.items);
                  },
                  onKeyDown: ({ event }) => {
                    if (event.key === 'ArrowDown') {
                      slashMenuState.moveSelection(1);
                      return true;
                    }
                    if (event.key === 'ArrowUp') {
                      slashMenuState.moveSelection(-1);
                      return true;
                    }
                    if (event.key === 'Enter' || event.key === 'Tab') {
                      slashMenuState.confirmSelected();
                      return true;
                    }
                    return false;
                  },
                  onExit: () => {
                    unmount?.();
                    slashMenuCmp.panelElement().style.display = 'none';
                    slashMenuState.hide();
                  },
                };
              },
            },
          }),
        ],
        content,
        onUpdate: ({ editor }) => {
          this.notesState.updateContent(this.noteId(), getMarkdown(editor));
        },
        onTransaction: ({ editor }) => this.updateActiveMarks(editor),
      });

      bubbleMenuCmp.setEditor(editor);

      this.editor = editor;
      this.lastAppliedNoteId = id;
    });

    effect(() => {
      const id = this.noteId();
      const editor = this.editor;
      if (!editor || id === this.lastAppliedNoteId) return;

      const content = untracked(() => this.notesState.getNote(id)?.content ?? '');
      editor.commands.setContent(content, { emitUpdate: false });
      this.lastAppliedNoteId = id;
    });

    this.destroyRef.onDestroy(() => this.editor?.destroy());
  }

  private updateActiveMarks(editor: Editor): void {
    this.bubbleMenuState.setActiveMarks({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      link: editor.isActive('link'),
    });
  }
}
