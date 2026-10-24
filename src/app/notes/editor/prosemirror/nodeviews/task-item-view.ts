import { Node as PMNode } from 'prosemirror-model';
import { EditorView, NodeView } from 'prosemirror-view';
import { revealTaskMarker } from '../plugins/syntax-reveal-plugin';

/**
 * Renders a task item with a clickable checkbox. The checkbox lives outside
 * `contentDOM` so ProseMirror only manages the item's block content. The thin
 * zone between checkbox and text highlights on hover, and a click on it shows
 * the item's `- [ ] ` in place of the checkbox.
 */
export class TaskItemView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly checkbox: HTMLInputElement;
  private readonly marker: HTMLElement;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined
  ) {
    this.dom = document.createElement('li');
    this.dom.className = 'flex items-start';
    this.dom.setAttribute('data-type', 'taskItem');

    this.checkbox = document.createElement('input');
    this.checkbox.type = 'checkbox';
    this.checkbox.className = 'task-checkbox';
    this.checkbox.checked = !!node.attrs['checked'];
    this.checkbox.addEventListener('change', () => this.toggle());

    this.marker = document.createElement('span');
    this.marker.contentEditable = 'false';
    this.marker.className = 'task-marker';
    this.marker.title = 'Show Markdown';
    this.marker.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const pos = this.getPos();
      const tr = pos === undefined ? null : revealTaskMarker(this.view.state, pos);
      if (tr) this.view.dispatch(tr);
      this.view.focus();
    });

    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'task-content';
    this.dom.append(this.checkbox, this.marker, this.contentDOM);
    this.syncChecked();
  }

  private toggle() {
    const pos = this.getPos();
    // Undefined once the node view has been detached from the document.
    if (typeof pos !== 'number') return;

    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        checked: this.checkbox.checked,
      })
    );
  }

  private syncChecked() {
    this.dom.setAttribute('data-checked', this.node.attrs['checked'] ? 'true' : 'false');
    // Its `- [ ] ` shows as text instead.
    const first = this.node.firstChild?.firstChild;
    this.dom.toggleAttribute('data-revealed', !!first && first.marks.some((mark) => mark.type.name === 'md_prefix'));
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.checkbox.checked = !!node.attrs['checked'];
    this.syncChecked();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target === this.checkbox || event.target === this.marker;
  }
}
