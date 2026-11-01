import { Node as PMNode } from 'prosemirror-model';
import { EditorView, NodeView } from 'prosemirror-view';
import { isMobile } from '../../../../core/tauri-env';
import { isPdfPath, isVideoPath } from '../../../attachments-state';
import { renderPdfPages } from '../../../pdf-pages';
import { imageContext, resizeImage } from '../plugins/image-plugin';
import { revealImageSource } from '../plugins/syntax-reveal-plugin';

const svg = (size: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const CODE_ICON = svg(14, '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>');
const OPEN_ICON = svg(14, '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>');
const ZOOM_ICON = svg(14, '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>');

/** An embedded PDF's frame height when the embed doesn't give one (`![[doc.pdf|600]]`). */
const PDF_HEIGHT = 480;

const TOOL = 'flex size-6 items-center justify-center rounded-md bg-surface/90 text-muted-foreground shadow-card hover:text-foreground';

/** The smallest a drag can make an image, in px. */
const MIN_SIZE = 24;

/**
 * An image size's `width` and `height` in px, either one null when it doesn't
 * give it. A PDF's lone number is its frame's height, an image's or video's its width.
 */
export function parseSize(size: string | null, pdf: boolean): { width: number | null; height: number | null } {
  const [, w, h] = /^(\d+)(?:x(\d+))?$/.exec(size ?? '') ?? [];
  const width = w ? parseInt(w, 10) || null : null;
  if (!h) return pdf ? { width: null, height: width } : { width, height: null };
  return { width, height: parseInt(h, 10) || null };
}

/** Which of an image's edges a resize handle drags: right, bottom, or the corner between. */
type Edge = 'e' | 's' | 'se';
const HANDLE: Record<Edge, string> = {
  // On the selection ring, inside the image, where the scroll area can't clip them.
  e: 'right-0 top-1/2 h-8 w-1.5 -translate-y-1/2 cursor-ew-resize',
  s: 'bottom-0 left-1/2 h-1.5 w-8 -translate-x-1/2 cursor-ns-resize',
  se: 'bottom-0 right-0 size-3 cursor-nwse-resize',
};

/** Opens the image at `url` enlarged over the page, with its caption; Esc or a click outside closes it. */
export function zoomImage(url: string, caption: string): void {
  const dialog = document.createElement('dialog');
  dialog.className =
    'm-auto max-h-none max-w-none overflow-visible border-0 bg-transparent p-0 outline-none backdrop:bg-black/60 backdrop:backdrop-blur-sm';
  const img = document.createElement('img');
  img.src = url;
  img.alt = caption;
  img.className = 'block max-h-[85vh] max-w-[90vw] rounded-lg shadow-card';
  dialog.append(img);
  if (caption) {
    const text = document.createElement('p');
    text.textContent = caption;
    text.className = 'mx-auto mt-3 max-w-[90vw] text-center text-[13px] text-white/90';
    dialog.append(text);
  }
  // A click on the backdrop lands on the dialog itself.
  dialog.addEventListener('click', (event) => event.target === dialog && dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * Renders an image node, loading a vault image through the `mantle://`
 * protocol rather than its Markdown `src` — as a player, for a video, and as a
 * scrollable frame of its pages, for a PDF. A
 * missing image, or one whose profile is locked, shows the browser's own
 * broken-image box with its alt text.
 *
 * On hover, buttons in its corner show its Markdown source and zoom it. A
 * click selects it; a second click zooms it. Right-clicking opens its
 * context menu.
 *
 * A selected one has resize handles (not on Android, where its context menu's
 * sizes stand in): the corner keeps an image's or video's shape and saves just
 * a width, the edges stretch it and save `WxH`. A PDF has no shape to keep, so
 * the corner saves both, and the bottom edge just a height unless it has a width.
 */
export class ImageView implements NodeView {
  readonly dom: HTMLElement;
  private img: HTMLElement;
  private readonly tools: HTMLElement;
  private readonly zoomButton: HTMLButtonElement;
  private readonly openButton: HTMLButtonElement;
  /** The PDF the frame shows, and how to stop drawing it. */
  private pdf: { url: string; stop?: () => void; cancelled?: boolean } | null = null;
  private readonly handles: HTMLElement;
  private selected = false;
  /** Whether the image was already selected when the current click began. */
  private clickedSelected = false;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('span');
    this.dom.className = 'group/image relative inline-block max-w-full align-bottom';
    this.img = document.createElement('img');
    this.dom.append(this.img);

    this.tools = document.createElement('span');
    this.tools.contentEditable = 'false';
    this.tools.className = 'absolute right-1.5 top-1.5 z-10 hidden gap-1 group-hover/image:flex';
    const source = this.tool('Show Markdown', CODE_ICON, () => {
      const pos = this.getPos();
      if (pos !== undefined) revealImageSource(this.view, pos);
    });
    this.zoomButton = this.tool('Zoom', ZOOM_ICON, () => this.zoom());
    this.openButton = this.tool('Open in tab', OPEN_ICON, () => imageContext(this.view)?.open(this.node.attrs['src']));
    this.tools.append(source, this.zoomButton, this.openButton);
    this.dom.append(this.tools);

    this.handles = document.createElement('span');
    this.handles.contentEditable = 'false';
    this.handles.className = 'hidden';
    for (const edge of ['e', 's', 'se'] as const) {
      const handle = document.createElement('span');
      handle.className = `absolute z-10 rounded-sm border border-surface bg-primary shadow-card ${HANDLE[edge]}`;
      handle.addEventListener('pointerdown', (event) => this.startResize(event, edge));
      this.handles.append(handle);
    }
    this.dom.append(this.handles);
    // Dragging a handle mustn't drag the image along with it.
    this.dom.addEventListener('dragstart', (event) => {
      if (event.target instanceof Node && this.handles.contains(event.target)) event.preventDefault();
    });

    this.dom.addEventListener('contextmenu', (event) => {
      const pos = this.getPos();
      if (pos !== undefined) imageContext(this.view)?.contextMenu(event, this.view, pos, this.node);
    });
    // Before ProseMirror handles the press, which (re)selects the image.
    this.dom.addEventListener('mousedown', (event) => (this.clickedSelected = this.selected && event.target === this.img));
    this.dom.addEventListener('click', (event) => {
      if (this.clickedSelected && event.target === this.img) this.zoom();
    });
    this.render();
  }

  private tool(label: string, icon: string, run: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    button.className = TOOL;
    button.addEventListener('click', run);
    return button;
  }

  /** Drags `edge`, sizing the media in place, and saves its size as one step once let go. */
  private startResize(event: PointerEvent, edge: Edge): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const media = this.img;
    const pdf = media instanceof HTMLDivElement;
    const start = media.getBoundingClientRect();
    const own = parseSize(this.node.attrs['size'], pdf);
    const maxWidth = this.view.dom.clientWidth;
    let size: string | null = null;

    const move = (e: PointerEvent) => {
      const clamp = (n: number, max = Infinity) => Math.round(Math.min(Math.max(n, MIN_SIZE), max));
      let width = clamp(edge === 's' ? start.width : start.width + e.clientX - event.clientX, maxWidth);
      let height = clamp(edge === 'e' ? start.height : start.height + e.clientY - event.clientY);
      if (edge === 'se' && !pdf) {
        height = Math.round((width * start.height) / start.width);
        size = `${width}`;
      } else if (edge === 's' && pdf && own.width === null) {
        size = `${height}`;
        width = start.width;
      } else size = `${width}x${height}`;
      media.style.width = `${width}px`;
      media.style.height = `${height}px`;
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      media.style.width = media.style.height = '';
      const pos = this.getPos();
      if (size !== null && pos !== undefined) resizeImage(this.view, pos, size);
      // Back to its saved size, even when the drag didn't change it.
      this.render();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end, { once: true });
    handle.addEventListener('pointercancel', end, { once: true });
  }

  private zoom(): void {
    if (!(this.img instanceof HTMLImageElement)) return;
    const { alt, title } = this.node.attrs;
    zoomImage(this.img.src, title ?? alt ?? '');
  }

  private render(): void {
    const { src, alt, title, size } = this.node.attrs;
    const pdf = isPdfPath(src);
    // The PDF frame is a `div`, kept apart from images by its tag.
    const tag = pdf ? 'div' : isVideoPath(src) ? 'video' : 'img';
    if (this.img.localName !== tag) {
      this.stopPdf();
      const media = document.createElement(tag);
      if (media instanceof HTMLVideoElement) media.controls = true;
      media.className = pdf
        ? 'note-pdf scrollbar-thin flex flex-col items-center gap-3 overflow-auto rounded-md border border-border bg-surface py-3'
        : 'note-image';
      this.img.replaceWith(media);
      this.img = media;
    }
    const { width, height } = parseSize(size, pdf);
    this.dom.classList.toggle('w-full', pdf && width === null);
    // A video plays in place; a PDF scrolls in place, or opens in a tab.
    this.zoomButton.hidden = tag !== 'img';
    this.openButton.hidden = !pdf;
    // Resolved on every render: a relative `src` depends on which note this is.
    const url = imageContext(this.view)?.url(src) ?? src;
    this.img.title = title ?? alt ?? '';
    if (this.img instanceof HTMLDivElement) {
      this.img.style.height = `${height ?? PDF_HEIGHT}px`;
      this.img.style.width = width === null ? '' : `${width}px`;
      if (this.pdf?.url !== url) this.showPdf(url);
      return;
    }
    const media = this.img as HTMLImageElement | HTMLVideoElement;
    if (media.getAttribute('src') !== url) media.src = url;
    if (media instanceof HTMLImageElement) media.alt = alt ?? '';
    for (const [attr, length] of [['width', width], ['height', height]] as const) {
      if (length === null) media.removeAttribute(attr);
      else media.setAttribute(attr, `${length}`);
    }
  }

  private showPdf(url: string): void {
    this.stopPdf();
    const frame = this.img;
    const pdf: NonNullable<ImageView['pdf']> = { url };
    this.pdf = pdf;
    renderPdfPages(url, frame, frame, 'shrink-0 bg-white shadow-card').then(
      (stop) => (pdf.cancelled ? stop() : (pdf.stop = stop)),
      () => {
        if (pdf.cancelled) return;
        frame.classList.add('items-center', 'justify-center');
        frame.textContent = "This PDF can't be shown. It may be missing, damaged, or encrypted under a locked profile.";
      },
    );
  }

  private stopPdf(): void {
    if (!this.pdf) return;
    this.pdf.cancelled = true;
    this.pdf.stop?.();
    this.pdf = null;
  }

  destroy(): void {
    this.stopPdf();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode(): void {
    this.selected = true;
    this.img.classList.add('ProseMirror-selectednode');
    // The next click zooms it.
    this.img.classList.toggle('cursor-pointer', this.img instanceof HTMLImageElement);
    if (!isMobile) this.handles.classList.remove('hidden');
  }

  deselectNode(): void {
    this.selected = false;
    this.img.classList.remove('ProseMirror-selectednode', 'cursor-pointer');
    this.handles.classList.add('hidden');
  }

  /** The buttons and handles are plain UI: keep ProseMirror out of their clicks, and out of their DOM. */
  stopEvent(event: Event): boolean {
    const target = event.target;
    return target instanceof Node && [this.tools, this.handles].some((ui) => ui.contains(target));
  }

  ignoreMutation(): boolean {
    return true;
  }
}
