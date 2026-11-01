import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { parseMarkdown, serializeMarkdown } from '../markdown-converter';
import { outline } from '../outline';
import { tocPlugin } from './toc-plugin';

describe('tocPlugin', () => {
  const markdown = '[TOC]\n\n# One\n\ntext\n\n## Two\n\n# Three';

  function mount(): EditorView {
    return new EditorView(document.createElement('div'), {
      state: EditorState.create({ doc: parseMarkdown(markdown), plugins: [tocPlugin()] }),
    });
  }

  it('lists the top-level headings', () => {
    expect(outline(parseMarkdown(markdown)).map((h) => [h.level, h.text])).toEqual([
      [1, 'One'],
      [2, 'Two'],
      [1, 'Three'],
    ]);
  });

  it('shows the headings as links under a [TOC] paragraph, which saves as written', () => {
    const view = mount();
    const links = [...view.dom.querySelectorAll('.toc a')].map((a) => a.textContent);
    expect(links).toEqual(['One', 'Two', 'Three']);
    expect(serializeMarkdown(view.state.doc)).toBe(markdown);
  });

  it('hides [TOC] until the cursor is in it, and a link takes the cursor to its heading', () => {
    const view = mount();
    // The cursor starts in it.
    expect(view.dom.querySelector('.toc-source')).toBeNull();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 10)));
    expect(view.dom.querySelector('.toc-source')).not.toBeNull();

    (view.dom.querySelectorAll('.toc a')[2] as HTMLElement).click();
    expect(view.state.selection.$head.parent.textContent).toBe('Three');
  });
});
