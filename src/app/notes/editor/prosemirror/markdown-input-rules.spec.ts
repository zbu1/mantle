import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { NoteEditor } from '../note-editor';
import { NotesState } from '../../notes-state';
import { VaultState } from '../../vault-state';
import { flushAsync, installMockVaultInvoke } from '../../../../testing/mock-vault';
import { schema } from './schema';
import { parseMarkdown, serializeMarkdown } from './markdown-converter';

function getEditorView(component: NoteEditor): EditorView {
  return (component as unknown as { editorView: EditorView }).editorView;
}

/**
 * Mirrors how prosemirror-view feeds typed characters through the
 * handleTextInput props, falling back to a plain insert when no rule matches.
 */
function type(view: EditorView, text: string) {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, char));
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

function pressBackspace(view: EditorView): boolean {
  return !!view.someProp('handleKeyDown', (f) =>
    f(view, new KeyboardEvent('keydown', { key: 'Backspace' }))
  );
}

function pressEnter(view: EditorView): boolean {
  return !!view.someProp('handleKeyDown', (f) =>
    f(view, new KeyboardEvent('keydown', { key: 'Enter' }))
  );
}

/**
 * The note as saved and reopened. While the cursor is in a construct the
 * editor shows its raw Markdown, so marks are checked on this instead.
 */
function folded(view: EditorView) {
  return parseMarkdown(serializeMarkdown(view.state.doc));
}

/** Empties the document so rules run against a clean paragraph. */
function clear(view: EditorView) {
  const empty = schema.nodes['doc'].createAndFill()!;
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, empty.content));
  view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
}

async function setup() {
  const fixture = TestBed.createComponent(NoteEditor);
  fixture.componentRef.setInput('noteId', 'daily-standup.mntl');
  fixture.detectChanges();
  await fixture.whenStable();
  await flushAsync();
  fixture.detectChanges();
  await fixture.whenStable();

  const view = getEditorView(fixture.componentInstance);
  clear(view);
  return { fixture, view };
}

describe('markdown input rules', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [NoteEditor],
      providers: [provideZonelessChangeDetection()],
    });
    installMockVaultInvoke();
    TestBed.inject(VaultState).rootPath.set('/fake/vault');
  });

  describe('block rules', () => {
    it.each([
      ['# ', 1],
      ['## ', 2],
      ['### ', 3],
      ['###### ', 6],
    ])('converts "%s" into a heading of level %i', async (input, level) => {
      const { view } = await setup();
      type(view, input);

      const block = view.state.doc.firstChild!;
      expect(block.type).toBe(schema.nodes['heading']);
      expect(block.attrs['level']).toBe(level);
    });

    it('leaves "####### " as literal text, since Markdown caps headings at h6', async () => {
      const { view } = await setup();
      type(view, '####### ');

      const block = view.state.doc.firstChild!;
      expect(block.type).toBe(schema.nodes['paragraph']);
      expect(block.textContent).toBe('####### ');
    });

    it('keeps the heading when a space is typed inside its revealed "# "', async () => {
      const { view } = await setup();
      type(view, '# ');
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
      type(view, ' ');

      const block = view.state.doc.firstChild!;
      expect(block.type).toBe(schema.nodes['heading']);
      expect(block.textContent).toBe('#  ');
    });

    it('keeps heading styling for text typed after the conversion', async () => {
      const { view } = await setup();
      type(view, '# Title');

      const block = folded(view).firstChild!;
      expect(block.type).toBe(schema.nodes['heading']);
      expect(block.textContent).toBe('Title');
    });

    it('converts "- " into a bullet list', async () => {
      const { view } = await setup();
      type(view, '- item');

      const list = view.state.doc.firstChild!;
      expect(list.type).toBe(schema.nodes['bullet_list']);
      expect(list.textContent).toBe('item');
    });

    it('converts "1. " into an ordered list carrying its start order', async () => {
      const { view } = await setup();
      type(view, '3. item');

      const list = view.state.doc.firstChild!;
      expect(list.type).toBe(schema.nodes['ordered_list']);
      expect(list.attrs['order']).toBe(3);
    });

    it('continues an existing ordered list rather than starting a new one', async () => {
      const { view } = await setup();

      // A one-item list followed by a plain paragraph, i.e. where the user has
      // left the list and starts typing the next number by hand.
      const list = schema.nodes['ordered_list'].create({ order: 1 }, [
        schema.nodes['list_item'].create(null, schema.nodes['paragraph'].create(null, schema.text('first'))),
      ]);
      const trailing = schema.nodes['paragraph'].create();
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, [list, trailing]));
      view.dispatch(
        view.state.tr.setSelection(TextSelection.atEnd(view.state.doc))
      );

      type(view, '2. second');

      expect(view.state.doc.childCount).toBe(1);
      const merged = view.state.doc.firstChild!;
      expect(merged.type).toBe(schema.nodes['ordered_list']);
      expect(merged.childCount).toBe(2);
      expect(merged.lastChild!.textContent).toBe('second');
    });

    it('converts "> " into a blockquote', async () => {
      const { view } = await setup();
      type(view, '> quoted');

      expect(view.state.doc.firstChild!.type).toBe(schema.nodes['blockquote']);
    });

    it('converts a triple backtick into a code block on Space', async () => {
      const { view } = await setup();
      type(view, '```');
      expect(view.state.doc.firstChild!.type).toBe(schema.nodes['paragraph']);
      type(view, ' ');

      expect(view.state.doc.firstChild!.type).toBe(schema.nodes['code_block']);
    });

    it('keeps a language typed after the backticks, on Space or Enter', async () => {
      const { view } = await setup();
      type(view, '```ts ');
      expect(view.state.doc.firstChild!.attrs['params']).toBe('ts');

      const second = await setup();
      type(second.view, '```python');
      expect(pressEnter(second.view)).toBe(true);
      const block = folded(second.view).firstChild!;
      expect(block.type).toBe(schema.nodes['code_block']);
      expect(block.attrs['params']).toBe('python');
      expect(block.textContent).toBe('');
    });

    it('converts "---" into a horizontal rule and leaves a cursor position after it', async () => {
      const { view } = await setup();
      type(view, '---');

      expect(view.state.doc.firstChild!.type).toBe(schema.nodes['horizontal_rule']);
      expect(view.state.doc.childCount).toBe(2);
      expect(view.state.doc.lastChild!.type).toBe(schema.nodes['paragraph']);
    });

    it.each([
      ['[ ] ', false],
      ['[x] ', true],
    ])('converts "- %s" into a task item with checked=%s', async (input, checked) => {
      const { view } = await setup();
      type(view, `- ${input}`);

      const list = view.state.doc.firstChild!;
      expect(list.type).toBe(schema.nodes['task_list']);

      const item = list.firstChild!;
      expect(item.type).toBe(schema.nodes['task_item']);
      expect(item.attrs['checked']).toBe(checked);
    });

    it('does not create a checkbox from "[ ] " without a list marker', async () => {
      const { view } = await setup();
      type(view, '[ ] ');

      const block = view.state.doc.firstChild!;
      expect(block.type).toBe(schema.nodes['paragraph']);
      expect(block.textContent).toBe('[ ] ');
    });

    it('splits the surrounding list around a checkbox turned on in the middle', async () => {
      const { view } = await setup();
      type(view, '- one');
      pressEnter(view);
      type(view, 'two');
      pressEnter(view);
      type(view, 'three');

      // Back to the start of "two" to turn just that item into a checkbox.
      let found = -1;
      view.state.doc.descendants((node, pos) => {
        if (found < 0 && node.isText && node.text === 'two') found = pos;
        return found < 0;
      });
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found)));
      type(view, '[ ] ');

      expect(view.state.doc.childCount).toBe(3);
      const [first, second, third] = [view.state.doc.child(0), view.state.doc.child(1), view.state.doc.child(2)];
      expect(first.type).toBe(schema.nodes['bullet_list']);
      expect(first.textContent).toBe('one');
      expect(second.type).toBe(schema.nodes['task_list']);
      expect(second.firstChild!.textContent).toBe('two');
      expect(third.type).toBe(schema.nodes['bullet_list']);
      expect(third.textContent).toBe('three');
    });
  });

  describe('inline mark rules', () => {
    it.each([
      ['**bold**', 'strong', 'bold'],
      ['__bold__', 'strong', 'bold'],
      ['*italic*', 'em', 'italic'],
      ['_italic_', 'em', 'italic'],
      ['~~struck~~', 'strike', 'struck'],
      ['`code`', 'code', 'code'],
    ])('converts %s into a %s mark', async (input, markName, text) => {
      const { view } = await setup();
      type(view, input);

      const paragraph = folded(view).firstChild!;
      expect(paragraph.textContent).toBe(text);

      const marked = paragraph.firstChild!;
      expect(schema.marks[markName].isInSet(marked.marks)).toBeTruthy();
    });

    it('does not carry the mark into text typed afterwards', async () => {
      const { view } = await setup();
      type(view, '**bold** plain');

      const paragraph = folded(view).firstChild!;
      expect(paragraph.textContent).toBe('bold plain');

      const lastChild = paragraph.lastChild!;
      expect(lastChild.text).toContain('plain');
      expect(schema.marks['strong'].isInSet(lastChild.marks)).toBeFalsy();
    });

    it('does not italicise underscores inside a word', async () => {
      const { view } = await setup();
      type(view, 'my_variable_name');

      const paragraph = folded(view).firstChild!;
      expect(paragraph.textContent).toBe('my_variable_name');
      expect(paragraph.childCount).toBe(1);
      expect(paragraph.firstChild!.marks).toHaveLength(0);
    });

    it('converts [text](url) into a link', async () => {
      const { view } = await setup();
      type(view, '[docs](https://example.com)');

      const paragraph = folded(view).firstChild!;
      expect(paragraph.textContent).toBe('docs');

      const link = schema.marks['link'].isInSet(paragraph.firstChild!.marks);
      expect(link?.attrs['href']).toBe('https://example.com');
    });

    it('leaves markdown untouched inside a code block', async () => {
      const { view } = await setup();
      type(view, '``` ');
      type(view, '**bold** # heading');

      const block = folded(view).firstChild!;
      expect(block.type).toBe(schema.nodes['code_block']);
      expect(block.textContent).toBe('**bold** # heading');
    });

    it('keeps an empty paragraph below a trailing code block to move the cursor into', async () => {
      const { view } = await setup();
      type(view, '``` ');
      type(view, 'const x = 1;');

      expect(view.state.doc.childCount).toBe(2);
      const trailing = view.state.doc.lastChild!;
      expect(trailing.type).toBe(schema.nodes['paragraph']);
      expect(trailing.textContent).toBe('');

      // The trailing paragraph is a serialization no-op: nothing follows it,
      // so it contributes no characters (and no blank line) to the saved markdown.
      expect(serializeMarkdown(view.state.doc)).toBe('```\nconst x = 1;\n```');
    });

    it('leaves markdown untouched inside an inline code span', async () => {
      const { view } = await setup();
      type(view, '`a*b*c`');

      const paragraph = folded(view).firstChild!;
      expect(paragraph.textContent).toBe('a*b*c');
      expect(schema.marks['code'].isInSet(paragraph.firstChild!.marks)).toBeTruthy();
    });

    it('does not apply marks when typing inside existing code-marked text', async () => {
      const { view } = await setup();

      // The cursor goes inside the (by then revealed) span. Without `inCodeMark: false`
      // the bold rule would fire here.
      const codeText = schema.text('a b', [schema.marks['code'].create()]);
      view.dispatch(
        view.state.tr.replaceWith(0, view.state.doc.content.size, [
          schema.nodes['paragraph'].create(null, codeText),
        ])
      );
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));

      type(view, '**bold**');

      const paragraph = folded(view).firstChild!;
      expect(paragraph.textContent).toBe('a**bold** b');
      expect(paragraph.childCount).toBe(1);
      expect(schema.marks['code'].isInSet(paragraph.firstChild!.marks)).toBeTruthy();
    });
  });

  describe('backspace', () => {
    it('edits the revealed "# " straight after a conversion, so deleting its space ends the heading', async () => {
      const { view } = await setup();
      type(view, '# ');
      const heading = view.state.doc.firstChild!;
      expect(heading.type).toBe(schema.nodes['heading']);
      expect(heading.textContent).toBe('# ');

      // A plain character delete is the browser's, not a keymap command.
      view.dispatch(view.state.tr.delete(view.state.selection.from - 1, view.state.selection.from));
      const block = view.state.doc.firstChild!;
      expect(block.type).toBe(schema.nodes['paragraph']);
      expect(block.textContent).toBe('#');
    });

    it('leaves a non-empty heading alone', async () => {
      const { view } = await setup();
      type(view, '# Title');
      view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));

      pressBackspace(view);
      expect(view.state.doc.firstChild!.type).toBe(schema.nodes['heading']);
    });

    it('lifts the only list item out of the list when backspacing at its start', async () => {
      const { view } = await setup();
      type(view, '1. first');
      view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));

      expect(pressBackspace(view)).toBe(true);
      const block = view.state.doc.firstChild!;
      expect(block.type).toBe(schema.nodes['paragraph']);
      expect(block.textContent).toBe('first');
    });

    it('drops a list item to a plain paragraph in place, keeping its text and cursor on the same line', async () => {
      const { view } = await setup();
      type(view, '1. first');
      pressEnter(view);
      type(view, 'second');
      const $from = view.state.selection.$from;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $from.start())));

      expect(pressBackspace(view)).toBe(true);
      expect(view.state.doc.childCount).toBe(2);
      const list = view.state.doc.firstChild!;
      expect(list.type).toBe(schema.nodes['ordered_list']);
      expect(list.childCount).toBe(1);
      expect(list.firstChild!.textContent).toBe('first');
      const trailing = view.state.doc.lastChild!;
      expect(trailing.type).toBe(schema.nodes['paragraph']);
      expect(trailing.textContent).toBe('second');
      const $cursor = view.state.selection.$from;
      expect($cursor.parent).toBe(trailing);
      expect($cursor.parentOffset).toBe(0);
    });

    it('merges into the previous item on a second Backspace, once the marker is already gone', async () => {
      const { view } = await setup();
      type(view, '1. first');
      pressEnter(view);
      type(view, 'second');
      const $from = view.state.selection.$from;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $from.start())));

      pressBackspace(view); // drops the marker, "second" becomes a plain paragraph
      expect(pressBackspace(view)).toBe(true);

      const list = view.state.doc.firstChild!;
      expect(view.state.doc.childCount).toBe(1);
      expect(list.type).toBe(schema.nodes['ordered_list']);
      expect(list.childCount).toBe(1);
      expect(list.firstChild!.textContent).toBe('firstsecond');
    });

    it('merges a trailing empty paragraph back into a list without adding a new entry', async () => {
      const { view } = await setup();
      type(view, '1. first');
      pressEnter(view); // new (empty) second item
      pressEnter(view); // empty item ends the list, leaving a trailing paragraph
      expect(view.state.doc.childCount).toBe(2);

      expect(pressBackspace(view)).toBe(true);
      expect(view.state.doc.childCount).toBe(1);
      const list = view.state.doc.firstChild!;
      expect(list.type).toBe(schema.nodes['ordered_list']);
      expect(list.childCount).toBe(1);
      expect(list.firstChild!.textContent).toBe('first');
    });
  });

  describe('task item checkbox', () => {
    it('toggles the checked attribute when the checkbox is clicked', async () => {
      const { fixture, view } = await setup();
      type(view, '- [ ] task');

      const checkbox: HTMLInputElement =
        fixture.nativeElement.querySelector('li[data-type="taskItem"] input[type="checkbox"]');
      expect(checkbox).toBeTruthy();
      expect(checkbox.checked).toBe(false);

      checkbox.click();

      const item = view.state.doc.firstChild!.firstChild!;
      expect(item.attrs['checked']).toBe(true);
      expect(
        fixture.nativeElement.querySelector('li[data-type="taskItem"]').getAttribute('data-checked')
      ).toBe('true');
    });

    it('persists the toggle to NotesState as markdown', async () => {
      const { fixture, view } = await setup();
      type(view, '- [ ] task');

      const notesState = TestBed.inject(NotesState);
      fixture.nativeElement.querySelector('input[type="checkbox"]').click();

      expect(notesState.getNote('daily-standup.mntl')?.content).toContain('[x] task');
    });
  });

  describe('markdown round-trip', () => {
    it('preserves the language of a fenced code block', async () => {
      const doc = parseMarkdown('```ts\nconst a = 1;\n```');

      const block = doc.firstChild!;
      expect(block.type).toBe(schema.nodes['code_block']);
      expect(block.attrs['params']).toBe('ts');
      expect(serializeMarkdown(doc)).toContain('```ts');
    });
  });

  describe('pasting markdown', () => {
    it('parses plain-text markdown into real nodes', async () => {
      const { view } = await setup();
      const slice = view.someProp('clipboardTextParser', (f) =>
        f('# Heading\n\n- one\n- two', view.state.doc.resolve(0), true, view)
      )!;

      view.dispatch(view.state.tr.replaceSelection(slice));

      const types = [];
      view.state.doc.forEach((node) => types.push(node.type));
      expect(types).toContain(schema.nodes['heading']);
      expect(types).toContain(schema.nodes['bullet_list']);
    });
  });
});
