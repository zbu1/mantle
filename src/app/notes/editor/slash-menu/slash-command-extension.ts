import { Extension } from '@tiptap/core';
import { Suggestion, SuggestionOptions } from '@tiptap/suggestion';
import { SlashCommandItem } from './slash-menu.model';

export interface SlashCommandExtensionOptions {
  suggestion: Partial<SuggestionOptions<SlashCommandItem, SlashCommandItem>>;
}

export const SlashCommand = Extension.create<SlashCommandExtensionOptions>({
  name: 'slashCommand',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        command: ({ editor, range, props }) => {
          props.run(editor.chain().focus().deleteRange(range)).run();
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashCommandItem, SlashCommandItem>({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
