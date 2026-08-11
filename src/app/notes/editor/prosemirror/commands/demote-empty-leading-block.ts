import { joinBackward, setBlockType } from 'prosemirror-commands';
import { Command, TextSelection } from 'prosemirror-state';
import { schema } from '../schema';

const DEMOTABLE = new Set([
  schema.nodes['heading'],
  schema.nodes['blockquote'],
  schema.nodes['code_block'],
]);

/**
 * Turns an empty heading/blockquote/code block back into a paragraph on
 * Backspace, for the case where there is nothing before it to join with and
 * the default behaviour would otherwise do nothing.
 */
export const demoteEmptyLeadingBlock: Command = (state, dispatch, view) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;

  // An empty textblock has no cursor position other than its start.
  const parent = selection.$from.parent;
  if (!DEMOTABLE.has(parent.type) || parent.content.size !== 0) return false;

  // Omitting dispatch tests applicability without applying anything.
  if (joinBackward(state, undefined, view)) return false;

  return setBlockType(schema.nodes['paragraph'])(state, dispatch);
};
