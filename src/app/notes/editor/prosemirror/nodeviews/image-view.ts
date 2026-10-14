import { Node as PMNode } from 'prosemirror-model';
import { EditorView, NodeView } from 'prosemirror-view';
import { editImageSource, imageContext } from '../plugins/image-plugin';

const LOCK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

/**
 * Renders an image node, loading a vault image through the `mantle://`
 * protocol rather than its Markdown `src`. A missing image, or one whose
 * profile is locked, shows the browser's own broken-image box with its alt
 * text.
 *
 * Selecting the image shows where it comes from — its file in the vault,
 * whether it's one of Mantle's attachments or the user's own file, and the
 * profile it's sealed under — with a button to edit its Markdown source.
 * Right-clicking opens its context menu.
 */
export class ImageView implements NodeView {
  readonly dom: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly bar: HTMLElement;
  private readonly barText: HTMLElement;
  /** Bumped per selection, so a slow lookup can't fill in a bar that has since moved on. */
  private describing = 0;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('span');
    this.dom.className = 'relative inline-block max-w-full align-bottom';
    this.img = document.createElement('img');
    this.img.className = 'note-image';
    this.dom.append(this.img);

    this.bar = document.createElement('span');
    this.bar.contentEditable = 'false';
    this.bar.className =
      'absolute left-0 top-full z-10 mt-1.5 hidden max-w-[min(100%,32rem)] min-w-56 items-center gap-2 rounded-md border border-border bg-surface px-2 py-1 text-[11px] leading-4 text-muted-foreground shadow-card';
    this.barText = document.createElement('span');
    this.barText.className = 'flex min-w-0 flex-1 items-center gap-1';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit Source';
    edit.className = 'shrink-0 rounded px-1.5 py-0.5 text-foreground/80 hover:bg-background hover:text-foreground';
    edit.addEventListener('click', () => void editImageSource(this.view, this.getPos()));
    this.bar.append(this.barText, edit);
    this.dom.append(this.bar);

    this.dom.addEventListener('contextmenu', (event) => {
      const pos = this.getPos();
      if (pos !== undefined) imageContext(this.view)?.contextMenu(event, this.view, pos, this.node);
    });
    this.render();
  }

  private render(): void {
    const { src, alt, title, size } = this.node.attrs;
    // Resolved on every render: a relative `src` depends on which note this is.
    this.img.src = imageContext(this.view)?.url(src) ?? src;
    this.img.alt = alt ?? '';
    this.img.title = title ?? alt ?? '';
    const width = parseInt(size ?? '', 10);
    if (width > 0) this.img.width = width;
    else this.img.removeAttribute('width');
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const moved = node.attrs['src'] !== this.node.attrs['src'];
    this.node = node;
    this.render();
    if (moved && !this.bar.classList.contains('hidden')) void this.describe();
    return true;
  }

  selectNode(): void {
    this.img.classList.add('ProseMirror-selectednode');
    this.bar.classList.replace('hidden', 'flex');
    void this.describe();
  }

  deselectNode(): void {
    this.img.classList.remove('ProseMirror-selectednode');
    this.bar.classList.replace('flex', 'hidden');
    this.describing++;
  }

  /** The bar is plain UI: keep ProseMirror out of its clicks, and out of its DOM. */
  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.bar.contains(event.target);
  }

  ignoreMutation(): boolean {
    return true;
  }

  private async describe(): Promise<void> {
    const ticket = ++this.describing;
    const src: string = this.node.attrs['src'];
    this.barText.textContent = src;
    const described = await imageContext(this.view)?.describe(src).catch(() => null);
    if (ticket !== this.describing) return;

    this.barText.replaceChildren();
    if (!described) {
      this.barText.textContent = /^[a-z][a-z0-9+.-]*:/i.test(src) ? `Remote image · ${src}` : `Not found · ${src}`;
      return;
    }
    if (described.profile) {
      const lock = document.createElement('span');
      lock.className = 'flex shrink-0 items-center gap-0.5 text-primary';
      lock.innerHTML = LOCK_ICON;
      lock.append(described.profile);
      lock.title = `Encrypted under "${described.profile}"`;
      this.barText.append(lock, ' · ');
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
    this.barText.append(kind, ' · ', path);
  }
}
