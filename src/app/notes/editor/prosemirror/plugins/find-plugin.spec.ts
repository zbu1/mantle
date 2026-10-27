import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo } from 'prosemirror-history';
import { parseMarkdown, serializeMarkdown } from '../markdown-converter';
import { schema } from '../schema';
import { FindQuery, findMatches, findNext, findPlugin, findStatus, replaceAll, replaceCurrent, setFindQuery } from './find-plugin';

const query = (text: string, options: Partial<FindQuery> = {}): FindQuery => ({
  text,
  matchCase: false,
  wholeWord: false,
  regex: false,
  ...options,
});

function editor(markdown: string): EditorView {
  const doc = parseMarkdown(markdown);
  const state = EditorState.create({ doc, selection: TextSelection.atStart(doc), plugins: [history(), findPlugin()] });
  return new EditorView(document.createElement('div'), { state });
}

const texts = (markdown: string, q: FindQuery) => findMatches(parseMarkdown(markdown), q).map((m) => m.text);

describe('find', () => {
  it('honours match case, whole word and regex', () => {
    expect(texts('Cat cat concat', query('cat'))).toEqual(['Cat', 'cat', 'cat']);
    expect(texts('Cat cat concat', query('cat', { matchCase: true }))).toEqual(['cat', 'cat']);
    expect(texts('Cat cat concat', query('cat', { wholeWord: true }))).toEqual(['Cat', 'cat']);
    expect(texts('a1 b22 c', query('[a-z]\\d+', { regex: true }))).toEqual(['a1', 'b22']);
    expect(texts('anything', query('(', { regex: true }))).toEqual([]);
  });

  it('matches what shows, not revealed delimiters or hidden comments', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('**bo', [schema.marks['md_raw'].create()]),
        schema.text('ld**', [schema.marks['md_raw'].create()]),
        schema.text(' secret', [schema.marks['comment'].create()]),
      ]),
    ]);
    expect(findMatches(doc, query('bold')).map((m) => m.text)).toEqual(['bold']);
    expect(findMatches(doc, query('secret'))).toEqual([]);
  });

  it('counts matches and steps through them, wrapping around', () => {
    const view = editor('one two one two one');
    setFindQuery(view, query('one'));
    expect(findStatus(view.state)).toEqual({ current: 1, total: 3 });
    findNext(view);
    expect(findStatus(view.state).current).toBe(1);
    findNext(view);
    findNext(view);
    expect(findStatus(view.state).current).toBe(3);
    findNext(view);
    expect(findStatus(view.state).current).toBe(1);
    findNext(view, true);
    expect(findStatus(view.state).current).toBe(3);
  });

  it('replaces one match, keeping its marks, as one undo step', () => {
    const view = editor('a **cat** and a cat');
    setFindQuery(view, query('cat'));
    replaceCurrent(view, 'dog');
    expect(serializeMarkdown(view.state.doc)).toBe('a **dog** and a cat');
    undo(view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc)).toBe('a **cat** and a cat');
  });

  it('replaces all with regex groups, as one undo step', () => {
    const view = editor('x=1, y=2');
    setFindQuery(view, query('(\\w)=(\\d)', { regex: true }));
    replaceAll(view, '$2=$1');
    expect(serializeMarkdown(view.state.doc)).toBe('1=x, 2=y');
    undo(view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc)).toBe('x=1, y=2');
  });
});
