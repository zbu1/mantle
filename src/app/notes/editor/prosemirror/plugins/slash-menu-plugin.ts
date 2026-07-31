import { Plugin, PluginKey } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { SlashMenuState } from '../../slash-menu/slash-menu-state';
import { filterSlashCommands, SlashCommandItem } from '../../slash-menu/slash-menu.model';
import { schema } from '../schema';

export const SlashMenuPluginKey = new PluginKey('slashMenuPlugin');

export function createSlashMenuPlugin(
  slashMenuState: SlashMenuState,
  getPanelElement: () => HTMLElement | null
): Plugin {
  let activeRange: { from: number; to: number } | null = null;

  function hide(panel: HTMLElement | null) {
    activeRange = null;
    slashMenuState.hide();
    if (panel) {
      panel.classList.add('invisible', 'opacity-0', 'pointer-events-none');
      panel.classList.remove('opacity-100');
    }
  }

  function executeItem(view: EditorView, item: SlashCommandItem) {
    const panel = getPanelElement();
    if (activeRange) {
      const tr = view.state.tr.delete(activeRange.from, activeRange.to);
      view.dispatch(tr);
    }
    hide(panel);
    item.run(view);
    view.focus();
  }

  return new Plugin({
    key: SlashMenuPluginKey,
    props: {
      handleKeyDown(view, event) {
        if (slashMenuState.items().length === 0) return false;

        if (event.key === 'ArrowDown') {
          slashMenuState.moveSelection(1);
          return true;
        }
        if (event.key === 'ArrowUp') {
          slashMenuState.moveSelection(-1);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          slashMenuState.confirmSelected();
          return true;
        }
        if (event.key === 'Escape') {
          hide(getPanelElement());
          return true;
        }
        return false;
      },
    },
    view() {
      return {
        update(view: EditorView) {
          const panel = getPanelElement();
          if (!panel) return;

          const { state } = view;
          const { selection } = state;

          if (!selection.empty) {
            hide(panel);
            return;
          }

          const $from = selection.$from;
          if ($from.parent.type === schema.nodes['code_block']) {
            hide(panel);
            return;
          }

          const textBefore = $from.parent.textBetween(0, $from.parentOffset, null, '\ufffc');
          const match = textBefore.match(/\/([\w-]*)$/);

          if (!match) {
            hide(panel);
            return;
          }

          const query = match[1];
          const slashPos = $from.pos - match[0].length;
          activeRange = { from: slashPos, to: $from.pos };

          const filtered = filterSlashCommands(query);
          if (filtered.length === 0) {
            hide(panel);
            return;
          }

          slashMenuState.show(filtered, (item) => executeItem(view, item));

          const coords = view.coordsAtPos(slashPos);
          const editorRect = view.dom.getBoundingClientRect();

          const left = Math.max(0, coords.left - editorRect.left);
          const top = Math.max(0, coords.bottom - editorRect.top + 4);

          panel.style.position = 'absolute';
          panel.style.left = `${left}px`;
          panel.style.top = `${top}px`;
          panel.classList.remove('invisible', 'opacity-0', 'pointer-events-none');
          panel.classList.add('opacity-100');
        },
      };
    },
  });
}
