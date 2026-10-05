import { Node as PMNode } from 'prosemirror-model';
import { EditorView, NodeView } from 'prosemirror-view';
import { imageContext } from '../plugins/image-plugin';

/**
 * Renders an image node, loading a vault image through the `mantle://`
 * protocol rather than its Markdown `src`. A missing image, or one whose
 * profile is locked, shows the browser's own broken-image box with its alt
 * text.
 */
export class ImageView implements NodeView {
  readonly dom: HTMLImageElement;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
  ) {
    this.dom = document.createElement('img');
    this.dom.className = 'note-image';
    this.render();
  }

  private render(): void {
    const { src, alt, title, size } = this.node.attrs;
    // Resolved on every render: a relative `src` depends on which note this is.
    this.dom.src = imageContext(this.view)?.url(src) ?? src;
    this.dom.alt = alt ?? '';
    this.dom.title = title ?? alt ?? '';
    const width = parseInt(size ?? '', 10);
    if (width > 0) this.dom.width = width;
    else this.dom.removeAttribute('width');
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
}
