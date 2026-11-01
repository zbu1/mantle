import { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from './schema';

/** A top-level heading, for a table of contents. */
export interface OutlineHeading {
  level: number;
  text: string;
  pos: number;
}

/** The doc's top-level headings, their text without any Markdown the cursor has revealed. */
export function outline(doc: PMNode): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  doc.forEach((node, pos) => {
    if (node.type !== schema.nodes['heading']) return;
    let text = '';
    node.forEach((child) => {
      if (child.isText && !child.marks.some((mark) => mark.type === schema.marks['md_raw'] || mark.type === schema.marks['md_prefix'])) {
        text += child.text;
      }
    });
    out.push({ level: node.attrs['level'], text: text.trim(), pos });
  });
  return out;
}

/** Puts the cursor at the end of the heading at `pos` (unfolding it if it's folded away) and scrolls it to the top. */
export function goToHeading(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos);
  if (node?.type !== schema.nodes['heading']) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + node.nodeSize - 1)));
  view.focus();
  (view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
}
