import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { parseMarkdown } from '../markdown-converter';
import { spellcheckPlugin } from './spellcheck-plugin';

const mockInvoke = jest.fn();
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));

describe('spellcheckPlugin', () => {
  it('underlines misspelled lowercase words only, outside code and links', async () => {
    mockInvoke.mockImplementation(async (_cmd: string, { words }: { words: string[] }) =>
      words.filter((w) => w.startsWith('zz')),
    );
    const md = 'zzword Zzcap zz9 `zzcode` [[zzlink]] https://zzsite.com fine\n\n```\nzzblock\n```';
    const view = new EditorView(document.createElement('div'), {
      state: EditorState.create({ doc: parseMarkdown(md), plugins: [spellcheckPlugin(() => true)] }),
    });
    await new Promise((r) => setTimeout(r, 400));
    const marked = [...view.dom.querySelectorAll('.spell-error')].map((e) => e.textContent);
    expect(marked).toEqual(['zzword']);
    expect(view.dom.getAttribute('spellcheck')).toBe('false');
    view.destroy();
  });
});
