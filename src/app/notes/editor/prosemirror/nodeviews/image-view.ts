import { Node as PMNode } from 'prosemirror-model';
import { EditorView, NodeView } from 'prosemirror-view';
import { isPdfPath, isVideoPath } from '../../../attachments-state';
import { renderPdfPages } from '../../../pdf-pages';
import { imageContext } from '../plugins/image-plugin';
import { revealImageSource } from '../plugins/syntax-reveal-plugin';

const svg = (size: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const LOCK_ICON = svg(11, '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>');
const CODE_ICON = svg(14, '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>');
const OPEN_ICON = svg(14, '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>');
const ZOOM_ICON = svg(14, '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>');

/** An embedded PDF's frame height when the embed doesn't give one (`![[doc.pdf|600]]`). */
const PDF_HEIGHT = 480;

const TOOL = 'flex size-6 items-center justify-center rounded-md bg-surface/90 text-muted-foreground shadow-card hover:text-foreground';

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
 * click selects it, showing where it comes from — its file in the vault,
 * whether it's one of Mantle's attachments or the user's own file, and the
 * profile it's sealed under; a second click zooms it. Right-clicking opens
 * its context menu.
 */
export class ImageView implements NodeView {
  readonly dom: HTMLElement;
  private img: HTMLElement;
  private readonly tools: HTMLElement;
  private readonly zoomButton: HTMLButtonElement;
  private readonly openButton: HTMLButtonElement;
  /** The PDF the frame shows, and how to stop drawing it. */
  private pdf: { url: string; stop?: () => void; cancelled?: boolean } | null = null;
  private readonly bar: HTMLElement;
  /** Bumped per selection, so a slow lookup can't fill in a bar that has since moved on. */
  private describing = 0;
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

    this.bar = document.createElement('span');
    this.bar.contentEditable = 'false';
    this.bar.className =
      'absolute left-0 top-full z-10 mt-1.5 hidden max-w-[min(100%,32rem)] min-w-56 items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] leading-4 text-muted-foreground shadow-card';
    this.dom.append(this.bar);

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
    this.dom.classList.toggle('w-full', pdf);
    // A video plays in place; a PDF scrolls in place, or opens in a tab.
    this.zoomButton.hidden = tag !== 'img';
    this.openButton.hidden = !pdf;
    // Resolved on every render: a relative `src` depends on which note this is.
    const url = imageContext(this.view)?.url(src) ?? src;
    this.img.title = title ?? alt ?? '';
    const length = parseInt(size ?? '', 10);
    if (this.img instanceof HTMLDivElement) {
      this.img.style.height = `${length > 0 ? length : PDF_HEIGHT}px`;
      if (this.pdf?.url !== url) this.showPdf(url);
      return;
    }
    const media = this.img as HTMLImageElement | HTMLVideoElement;
    if (media.getAttribute('src') !== url) media.src = url;
    if (media instanceof HTMLImageElement) media.alt = alt ?? '';
    if (length > 0) media.width = length;
    else media.removeAttribute('width');
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
    const moved = node.attrs['src'] !== this.node.attrs['src'];
    this.node = node;
    this.render();
    if (moved && this.selected) void this.describe();
    return true;
  }

  selectNode(): void {
    this.selected = true;
    this.img.classList.add('ProseMirror-selectednode');
    this.bar.classList.replace('hidden', 'flex');
    void this.describe();
  }

  deselectNode(): void {
    this.selected = false;
    this.img.classList.remove('ProseMirror-selectednode');
    this.bar.classList.replace('flex', 'hidden');
    this.describing++;
  }

  /** The buttons and bar are plain UI: keep ProseMirror out of their clicks, and out of their DOM. */
  stopEvent(event: Event): boolean {
    return event.target instanceof Node && (this.bar.contains(event.target) || this.tools.contains(event.target));
  }

  ignoreMutation(): boolean {
    return true;
  }

  private async describe(): Promise<void> {
    const ticket = ++this.describing;
    const src: string = this.node.attrs['src'];
    this.bar.textContent = src;
    const described = await imageContext(this.view)?.describe(src).catch(() => null);
    if (ticket !== this.describing) return;

    this.bar.replaceChildren();
    if (!described) {
      this.bar.textContent = /^[a-z][a-z0-9+.-]*:/i.test(src) ? `Remote image · ${src}` : `Not found · ${src}`;
      return;
    }
    if (described.profile) {
      const lock = document.createElement('span');
      lock.className = 'flex shrink-0 items-center gap-0.5 text-primary';
      lock.innerHTML = LOCK_ICON;
      lock.append(described.profile);
      lock.title = `Encrypted under "${described.profile}"`;
      this.bar.append(lock, ' · ');
    }
    const kind = document.createElement('span');
    kind.className = 'shrink-0';
    kind.textContent = described.managed ? 'Attachment' : 'Vault file';
    kind.title = described.managed
      ? "Stored in Mantle's attachments folder"
      : 'A file of your own, elsewhere in the vault';
    const path = document.createElement('span');
    path.className = 'min-w-0 truncate font-mono text-foreground/80';
    path.textContent = described.relPath;
    path.title = described.relPath;
    this.bar.append(kind, ' · ', path);
  }
}
