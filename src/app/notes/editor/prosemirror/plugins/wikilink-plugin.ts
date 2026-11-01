import { placeAtCaret } from './popup-position';
import { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { splitLink } from '../../../links';
import { LinkMenuState, LinkSuggestion } from '../../link-menu/link-menu-state';
import { schema } from '../schema';

/** Whether a `[[link]]` leads to a note (or file). */
export type LinkStatus = 'ok' | 'missing';

export interface WikilinkContext {
  status(target: string): LinkStatus;
  /** The notes a `[[` followed by `query` could link to, best first. */
  suggest(query: string): LinkSuggestion[];
}

/** Dispatch a transaction with this meta to re-check every link, e.g. once the vault changed. */
export const wikilinkKey = new PluginKey<DecorationSet>('wikilink');

const wikilinkMark = schema.marks['wikilink'];

function brokenLinks(doc: PMNode, context: WikilinkContext): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const mark = node.isText && wikilinkMark.isInSet(node.marks);
    if (!mark) return;
    if (context.status(splitLink(mark.attrs['target']).target) === 'missing') {
      decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'wikilink-broken', title: 'No note with this name' }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

/** The targets of the `[[links]]` in `doc`, as the scan reports them for a note. */
export function wikilinkTargets(doc: PMNode): string[] {
  const targets = new Set<string>();
  doc.descendants((node) => {
    const mark = node.isText && wikilinkMark.isInSet(node.marks);
    if (mark) targets.add(splitLink(mark.attrs['target']).target);
  });
  return [...targets].filter(Boolean);
}

/**
 * `[[links]]` to notes: marks the ones that lead nowhere, and offers the
 * vault's notes to complete one as it's typed, in the `LinkMenu` panel.
 */
export function wikilinkPlugin(context: WikilinkContext, menu: LinkMenuState, panel: () => HTMLElement | null): Plugin<DecorationSet> {
  /** The `[[query` being completed. */
  let active: { from: number; to: number } | null = null;
  /** Where Escape closed the menu, so it stays closed for that link. */
  let dismissed: number | null = null;

  const hide = () => {
    active = null;
    menu.hide();
    panel()?.classList.add('invisible', 'opacity-0', 'pointer-events-none');
  };

  const complete = (view: EditorView, suggestion: LinkSuggestion) => {
    if (!active) return;
    const { from, to } = active;
    // Swallow a `]]` already after the cursor.
    const end = view.state.doc.textBetween(to, Math.min(to + 2, view.state.doc.resolve(to).end())) === ']]' ? to + 2 : to;
    const text = `[[${suggestion.link}]]`;
    const tr = view.state.tr.replaceWith(from, end, schema.text(text, [schema.marks['md_raw'].create()]));
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + text.length)).scrollIntoView());
    hide();
    view.focus();
  };

  return new Plugin<DecorationSet>({
    key: wikilinkKey,
    state: {
      init: (_, state) => brokenLinks(state.doc, context),
      apply: (tr, value) => (tr.docChanged || tr.getMeta(wikilinkKey) ? brokenLinks(tr.doc, context) : value),
    },
    props: {
      decorations: (state) => wikilinkKey.getState(state),
      handleKeyDown(view, event) {
        if (!active || menu.items().length === 0) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          menu.moveSelection(event.key === 'ArrowDown' ? 1 : -1);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const suggestion = menu.selected();
          if (suggestion) complete(view, suggestion);
          return true;
        }
        if (event.key === 'Escape') {
          dismissed = active.from;
          hide();
          return true;
        }
        return false;
      },
    },
    view() {
      return {
        update(view) {
          const { selection } = view.state;
          const $from = selection.$from;
          const before = selection.empty && !$from.parent.type.spec.code
            ? $from.parent.textBetween(0, $from.parentOffset, null, '￼')
            : '';
          const match = /\[\[([^[\]|#\n￼]*)$/.exec(before);
          const from = match ? $from.pos - match[1].length - 2 : -1;
          if (!match || from === dismissed) {
            if (!match) dismissed = null;
            return hide();
          }
          active = { from, to: $from.pos };
          const suggestions = context.suggest(match[1]);
          if (suggestions.length === 0) return hide();
          menu.show(suggestions, (suggestion) => complete(view, suggestion));

          const el = panel();
          if (!el) return;
          placeAtCaret(el, view, from);
          el.classList.remove('invisible', 'opacity-0', 'pointer-events-none');
        },
        destroy: hide,
      };
    },
  });
}
