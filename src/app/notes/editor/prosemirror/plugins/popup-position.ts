import { EditorView } from 'prosemirror-view';

/** Places `panel` under the caret at `pos`, or above it when the keyboard or scroll edge would cover it. */
export function placeAtCaret(panel: HTMLElement, view: EditorView, pos: number): void {
  place(panel, view, pos);
  requestAnimationFrame(() => place(panel, view, pos)); // the items render after this call, so the first height is stale
}

function place(panel: HTMLElement, view: EditorView, pos: number): void {
  if (pos > view.state.doc.content.size) return;
  const caret = view.coordsAtPos(pos);
  const box = view.dom.getBoundingClientRect();
  const clip = visibleArea(view.dom);
  const height = panel.offsetHeight;
  const below = caret.bottom + 4;
  const above = caret.top - 4 - height;
  const flip = below + height > clip.bottom && caret.top - clip.top > clip.bottom - caret.bottom;
  panel.style.position = 'absolute';
  panel.style.left = `${Math.max(0, caret.left - box.left)}px`;
  panel.style.top = `${Math.max(0, (flip ? above : below) - box.top)}px`;
}

function visibleArea(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(p).overflowY)) continue;
    const r = p.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
    break;
  }
  return { top, bottom };
}
