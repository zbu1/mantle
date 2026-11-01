import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { OutlineHeading, goToHeading, outline } from '../outline';
import { schema } from '../schema';

/** The paragraph that stands for a table of contents, as Typora writes it. */
const TOC_MARKER = /^\[toc\]$/i;

function tocWidget(headings: OutlineHeading[]): (view: EditorView) => HTMLElement {
  return (view) => {
    const nav = document.createElement('nav');
    nav.contentEditable = 'false';
    nav.className = 'toc';
    nav.setAttribute('aria-label', 'Table of contents');
    if (!headings.length) nav.textContent = 'No headings yet.';
    const top = Math.min(...headings.map((h) => h.level));
    headings.forEach((heading, i) => {
      const link = document.createElement('a');
      link.textContent = heading.text || 'Untitled';
      link.style.paddingLeft = `${(heading.level - top) * 1.25}em`;
      // Keeps the cursor out of the marker, which would show it as text.
      link.addEventListener('mousedown', (event) => event.preventDefault());
      link.addEventListener('click', (event) => {
        event.preventDefault();
        // Looked up now: the doc may have changed since this was drawn.
        const target = outline(view.state.doc)[i];
        if (target) goToHeading(view, target.pos);
      });
      nav.append(link);
    });
    return nav;
  };
}

/**
 * A `[TOC]` paragraph shows the note's top-level headings, each a link to its
 * heading. The `[TOC]` itself only shows while the cursor is in it, and is
 * saved as written.
 */
export function tocPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        let headings: OutlineHeading[] | undefined;
        const { head } = state.selection;
        state.doc.forEach((node, pos) => {
          if (node.type !== schema.nodes['paragraph'] || !TOC_MARKER.test(node.textContent.trim())) return;
          headings ??= outline(state.doc);
          const end = pos + node.nodeSize;
          const editing = head > pos && head < end;
          decorations.push(
            Decoration.node(pos, end, { class: `toc-block${editing ? ' toc-editing' : ''}` }),
            // Redrawn only when what it lists changes.
            // After the text, so the list sits under `[TOC]` while it's shown.
            Decoration.widget(end - 1, tocWidget(headings), {
              side: 1,
              ignoreSelection: true,
              key: `toc-${JSON.stringify(headings.map((h) => [h.level, h.text]))}`,
            }),
          );
          if (!editing) decorations.push(Decoration.inline(pos + 1, end - 1, { class: 'toc-source' }));
        });
        return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
      },
    },
  });
}
