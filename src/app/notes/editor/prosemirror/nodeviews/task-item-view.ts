import { Node as PMNode } from 'prosemirror-model';
import { EditorView, NodeView } from 'prosemirror-view';

/**
 * Renders a task item with a clickable checkbox. The checkbox lives outside
 * `contentDOM` so ProseMirror only manages the item's block content.
 */
export class TaskItemView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly checkbox: HTMLInputElement;

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined
  ) {
    this.dom = document.createElement('li');
    this.dom.className = 'flex items-start gap-2 my-1';
    this.dom.setAttribute('data-type', 'taskItem');

    this.checkbox = document.createElement('input');
    this.checkbox.type = 'checkbox';
    this.checkbox.checked = !!node.attrs['checked'];
    this.checkbox.addEventListener('change', () => this.toggle());

    this.contentDOM = document.createElement('div');
    this.dom.append(this.checkbox, this.contentDOM);
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
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.checkbox.checked = !!node.attrs['checked'];
    this.syncChecked();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target === this.checkbox;
  }
}
