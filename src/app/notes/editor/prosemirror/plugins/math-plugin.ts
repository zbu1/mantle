import { Node as PMNode } from 'prosemirror-model';
import { Command, Plugin, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { schema } from '../schema';

const math = schema.marks['math'];
/** Loaded with the first math shown, to keep it out of the initial bundle. */
let katex: Promise<typeof import('katex')> | undefined;

/**
 * Each run of `math` text, rendered with KaTeX in front of its hidden source.
 * ponytail: two math spans side by side (`$a$$b$`) share one mark and merge into one; split by mark identity if that bites.
 */
function mathDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let run: { from: number; tex: string; display: boolean } | null = null;
    const flush = () => {
      if (!run) return;
      const { from, tex, display } = run;
      decorations.push(
        Decoration.widget(
          from,
          () => {
            const el = document.createElement('span');
            el.className = 'md-math-rendered';
            el.textContent = tex;
            void (katex ??= import('katex')).then(({ default: k }) =>
              k.render(tex, el, { displayMode: display, throwOnError: false, errorColor: 'var(--destructive)' }),
            );
            return el;
          },
          { key: `${display}:${tex}`, side: -1 },
        ),
      );
      run = null;
    };
    node.forEach((child, offset) => {
      const mark = math.isInSet(child.marks);
      if (!mark) return flush();
      run ??= { from: pos + 1 + offset, tex: '', display: mark.attrs['display'] };
      run.tex += child.text ?? '';
    });
    flush();
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** Renders `$math$`; a click on it puts the cursor in its source, which syntax reveal then shows. */
export function mathPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    state: {
      init: (_, state) => mathDecorations(state.doc),
      apply: (tr, value) => (tr.docChanged ? mathDecorations(tr.doc) : value),
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
      handleDOMEvents: {
        mousedown: (view, event) => {
          const rendered = (event.target as Element).closest?.('.md-math-rendered');
          if (!rendered || event.button !== 0) return false;
          event.preventDefault();
          const pos = view.posAtDOM(rendered, 0) + 1;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
          view.focus();
          return true;
        },
      },
    },
  });
}

/** Enter inside a revealed `$$` block that isn't closed yet adds a line to it rather than ending the paragraph. */
export const newlineInMathBlock: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parent.type.spec.code) return false;
  const before = $cursor.parent.textBetween(0, $cursor.parentOffset, '\n', '\n');
  if ((before.match(/\$\$/g) ?? []).length % 2 === 0) return false;
  dispatch?.(state.tr.replaceSelectionWith(schema.nodes['hard_break'].create()).scrollIntoView());
  return true;
};
