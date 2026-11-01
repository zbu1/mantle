import { invoke } from '@tauri-apps/api/core';
import { Node as PMNode } from 'prosemirror-model';
import { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import { fenceLanguage, languageName } from '../code-languages';
import { codeBody } from '../markdown-converter';
import { codeBlockContext } from '../plugins/code-block-plugin';

const COPY_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** What a previewed block renders to. Mirrors `TypstOutput` in `typst_render.rs`. */
type PreviewOutput = { kind: 'svg'; svg: string } | { kind: 'error'; errors: string[] };

/** How long typing pauses before a previewed block renders again. */
const PREVIEW_DEBOUNCE_MS = 400;

let mermaidIds = 0;

/** Mermaid draws in the page, so it's loaded only once a note has a ```` ```mermaid ```` block. */
async function renderMermaid(code: string): Promise<PreviewOutput> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    // Shown as an <img>, which can't draw HTML labels.
    htmlLabels: false,
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
  });
  try {
    return { kind: 'svg', svg: (await mermaid.render(`mermaid-${++mermaidIds}`, code)).svg };
  } catch (err) {
    return { kind: 'error', errors: [err instanceof Error ? err.message : String(err)] };
  }
}

/** The fence languages a block shows a rendered preview for, under its code. */
const PREVIEWS: Record<string, (code: string) => Promise<PreviewOutput>> = {
  typst: (code) => invoke<PreviewOutput>('render_typst', { code }),
  mermaid: renderMermaid,
};

const BUTTON = 'rounded px-1.5 py-0.5 text-[11px] leading-4 text-muted-foreground hover:bg-background hover:text-foreground';

/**
 * A code block with its language in the top-right corner — a button that
 * opens the language picker — and, on hover, a copy button beside it.
 * A ```` ```typst ```` or ```` ```mermaid ```` block also shows what it
 * renders to, or its errors, below the code.
 */
export class CodeBlockView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly label: HTMLButtonElement;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  private preview: HTMLElement | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  /** The language and source last sent to render, so unrelated updates don't render again. */
  private previewSource: string | null = null;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'code-block group/code relative';

    this.toolbar = document.createElement('div');
    this.toolbar.contentEditable = 'false';
    // Over the code's top line (see `.code-block` in styles.css).
    this.toolbar.className = 'absolute right-1.5 top-[0.4em] z-10 flex h-6 items-center gap-0.5';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.title = 'Copy code';
    copy.setAttribute('aria-label', 'Copy code');
    copy.innerHTML = COPY_ICON;
    copy.className = `${BUTTON} opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100`;
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(codeBody(this.node).text);
      copy.innerHTML = CHECK_ICON;
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => (copy.innerHTML = COPY_ICON), 1200);
    });

    this.label = document.createElement('button');
    this.label.type = 'button';
    this.label.title = 'Change language';
    this.label.className = BUTTON;
    this.label.addEventListener('click', () => {
      const pos = this.getPos();
      if (pos !== undefined) codeBlockContext(this.view)?.pickLanguage(this.view, pos, this.label);
    });

    this.toolbar.append(copy, this.label);
    const pre = document.createElement('pre');
    this.contentDOM = document.createElement('code');
    pre.append(this.contentDOM);
    this.dom.append(this.toolbar, pre);
    this.render();
  }

  private render(): void {
    const params: string = this.node.attrs['params'];
    this.dom.classList.toggle('revealed', !!this.node.attrs['revealed']);
    // An unknown language still shows what the fence says, so it doesn't read as lost.
    this.label.textContent = languageName(params) ?? (fenceLanguage(params) || 'Plain text');
    this.renderPreview();
  }

  private renderPreview(): void {
    const { text, params } = codeBody(this.node);
    const language = fenceLanguage(params).toLowerCase();
    if (!Object.hasOwn(PREVIEWS, language)) {
      clearTimeout(this.previewTimer);
      this.preview?.remove();
      this.preview = this.previewSource = null;
      return;
    }
    if (!this.preview) {
      this.preview = document.createElement('div');
      this.preview.contentEditable = 'false';
      this.dom.append(this.preview);
    }
    this.preview.className = `code-preview ${language}-preview`;
    const source = `${language}\n${text}`;
    if (source === this.previewSource) return;
    clearTimeout(this.previewTimer);
    // The first render isn't waiting on typing.
    const delay = this.previewSource === null ? 0 : PREVIEW_DEBOUNCE_MS;
    this.previewTimer = setTimeout(() => void this.renderOutput(language, text, source), delay);
  }

  private async renderOutput(language: string, code: string, source: string): Promise<void> {
    this.previewSource = source;
    let output: PreviewOutput;
    try {
      output = await PREVIEWS[language](code);
    } catch (err) {
      output = { kind: 'error', errors: [String(err)] };
    }
    const preview = this.preview;
    if (!preview || this.previewSource !== source) return;
    preview.classList.toggle('error', output.kind === 'error');
    if (output.kind === 'svg') {
      // An <img>, not inline SVG: links or anything else in the output can't run in the editor.
      const img = document.createElement('img');
      img.alt = `${language} output`;
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(output.svg)}`;
      preview.replaceChildren(img);
    } else {
      preview.textContent = output.errors.join('\n');
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  /** The toolbar's clicks are its own, not the editor's. */
  stopEvent(event: Event): boolean {
    return event.target instanceof Node && (this.toolbar.contains(event.target) || !!this.preview?.contains(event.target));
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return (
      mutation.type !== 'selection' && (this.toolbar.contains(mutation.target) || !!this.preview?.contains(mutation.target))
    );
  }

  destroy(): void {
    clearTimeout(this.copiedTimer);
    clearTimeout(this.previewTimer);
    this.preview = null;
  }
}
