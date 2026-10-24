import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../schema';
import { newlineInMathBlock } from './math-plugin';

describe('Enter in a $$ block', () => {
  const enterAfter = (line: string) => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(line)])]);
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1 + line.length) });
    const handled = newlineInMathBlock(state, (tr) => (state = state.apply(tr)));
    return { handled, breaks: state.doc.firstChild!.childCount > 1 };
  };

  it('adds a line until the block is closed', () => {
    expect(enterAfter('$$')).toEqual({ handled: true, breaks: true });
    expect(enterAfter('$$x$$')).toEqual({ handled: false, breaks: false });
    expect(enterAfter('costs $5')).toEqual({ handled: false, breaks: false });
  });
});
