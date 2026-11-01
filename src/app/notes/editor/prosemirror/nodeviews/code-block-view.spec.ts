import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { installTauriMock } from '../../../../../testing/tauri-mock';
import { flushAsync } from '../../../../../testing/mock-vault';
import { parseMarkdown } from '../markdown-converter';
import { CodeBlockView } from './code-block-view';

const mockMermaid = { initialize: jest.fn(), render: jest.fn() };
jest.mock('mermaid', () => ({ __esModule: true, default: mockMermaid }));

describe('CodeBlockView previews', () => {
  function mount(markdown: string): EditorView {
    return new EditorView(document.createElement('div'), {
      state: EditorState.create({ doc: parseMarkdown(markdown) }),
      nodeViews: { code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos) },
    });
  }

  it('shows the compiled SVG under a typst block, and errors as text', async () => {
    const mock = installTauriMock();
    mock.respondWith('render_typst', { kind: 'svg', svg: '<svg></svg>' });
    const view = mount('```typst\n$x$\n```');
    await new Promise((r) => setTimeout(r, 0));
    await flushAsync();
    expect(mock.invoke.mock.calls[0].slice(0, 2)).toEqual(['render_typst', { code: '$x$' }]);
    expect(view.dom.querySelector('.typst-preview img')?.getAttribute('src')).toContain('image/svg+xml');

    mock.respondWith('render_typst', { kind: 'error', errors: ['Line 1: unknown variable'] });
    const broken = mount('```typst\n#nope\n```');
    await new Promise((r) => setTimeout(r, 0));
    await flushAsync();
    expect(broken.dom.querySelector('.typst-preview.error')?.textContent).toBe('Line 1: unknown variable');
  });

  it('draws a mermaid block, and shows its syntax errors', async () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: false });
    mockMermaid.render.mockResolvedValueOnce({ svg: '<svg></svg>' });
    const view = mount('```mermaid\ngraph TD; A-->B\n```');
    await new Promise((r) => setTimeout(r, 0));
    await flushAsync();
    expect(mockMermaid.render.mock.calls[0][1]).toBe('graph TD; A-->B');
    expect(view.dom.querySelector('.mermaid-preview img')?.getAttribute('src')).toContain('image/svg+xml');

    mockMermaid.render.mockRejectedValueOnce(new Error('Parse error on line 1'));
    const broken = mount('```mermaid\ngraph ->\n```');
    await new Promise((r) => setTimeout(r, 0));
    await flushAsync();
    expect(broken.dom.querySelector('.mermaid-preview.error')?.textContent).toBe('Parse error on line 1');
  });

  it('leaves other code blocks alone', () => {
    const view = mount('```ts\nlet x = 1\n```');
    expect(view.dom.querySelector('.code-preview')).toBeNull();
  });
});
