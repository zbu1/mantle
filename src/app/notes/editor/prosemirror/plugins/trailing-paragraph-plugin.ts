import { Plugin } from 'prosemirror-state';
import { schema } from '../schema';

const paragraphType = schema.nodes['paragraph'];

/**
 * Keeps an empty paragraph after a trailing code block. Unlike headings,
 * blockquotes and lists — which already fall through to a split/lift on
 * Enter — a code node's `newlineInCode` handler unconditionally inserts a
 * literal newline, so there's otherwise no way to move the cursor past it
 * when it's the last node in the document.
 */
export function trailingParagraphPlugin(): Plugin {
  return new Plugin({
    appendTransaction(_transactions, _oldState, newState) {
      const lastNode = newState.doc.lastChild;
      if (!lastNode || !lastNode.type.spec['code']) return null;

      return newState.tr.insert(newState.doc.content.size, paragraphType.create());
    },
  });
}
