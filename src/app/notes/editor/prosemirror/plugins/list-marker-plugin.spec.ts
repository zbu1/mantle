import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice } from 'prosemirror-model';
import { parseMarkdown } from '../markdown-converter';
import { listMarkerPlugin } from './list-marker-plugin';

/** An editor on `markdown`, selecting from the start of `fromWord` to the end of `toWord`. */
function select(markdown: string, fromWord: string, toWord: string): EditorView {
  const doc = parseMarkdown(markdown);
  const find = (word: string) => {
    let pos = -1;
    doc.descendants((node, p) => {
      if (pos < 0 && node.isText && node.text!.includes(word)) pos = p + node.text!.indexOf(word);
    });
    return pos;
  };
  const plugin = listMarkerPlugin();
  const selection = TextSelection.create(doc, find(fromWord), find(toWord) + toWord.length);
  return new EditorView(document.createElement('div'), { state: EditorState.create({ doc, selection, plugins: [plugin] }) });
}

function copy(view: EditorView): { slice: Slice; text: string } {
  const props = view.state.plugins[0].props;
  const slice = props.transformCopied!.call(null as never, view.state.selection.content(), view);
  return { slice, text: props.clipboardTextSerializer!.call(null as never, slice, view) };
}

describe('listMarkerPlugin', () => {
  it('copies items selected from an item start as a list, with their markers', () => {
    const { slice, text } = copy(select('- one\n- two\n- three', 'two', 'thr'));
    expect(slice.openStart).toBe(0);
    expect(slice.content.firstChild!.type.name).toBe('bullet_list');
    expect(text).toBe('- two\n- thr');
  });

  it('keeps numbers and checkboxes', () => {
    expect(copy(select('1. one\n2. two', 'one', 'two')).text).toBe('1. one\n2. two');
    expect(copy(select('- [x] one\n- [ ] two', 'one', 'two')).text).toBe('- [x] one\n- [ ] two');
  });

  it('leaves a selection inside one line as text', () => {
    const { slice, text } = copy(select('- one two', 'one', 'one'));
    expect(slice.openStart).toBeGreaterThan(0);
    expect(text).toBe('one');
  });
});
