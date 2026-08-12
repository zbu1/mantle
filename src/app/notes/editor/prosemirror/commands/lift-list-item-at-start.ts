import { Command, TextSelection } from 'prosemirror-state';
import { NodeType } from 'prosemirror-model';
import { liftListItem } from 'prosemirror-schema-list';

/**
 * Backspace at the very start of a list item's first block turns that item
 * into a plain block in place (dedenting one level) instead of merging its
 * text into the previous item — the marker disappears but the cursor and
 * text stay put. A second Backspace, now outside the list, falls through to
 * the normal join-with-previous-block behaviour.
 */
export function liftListItemAtStart(itemType: NodeType): Command {
  return (state, dispatch, view) => {
    const { selection } = state;
    if (!(selection instanceof TextSelection) || !selection.empty) return false;
    const $cursor = selection.$cursor;
    if (!$cursor) return false;
    if (view ? !view.endOfTextblock('backward', state) : $cursor.parentOffset > 0) return false;

    const range = $cursor.blockRange();
    if (!range || range.parent.type !== itemType || range.startIndex !== 0) return false;

    return liftListItem(itemType)(state, dispatch, view);
  };
}
