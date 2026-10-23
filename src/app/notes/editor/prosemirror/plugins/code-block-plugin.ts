import { Node as PMNode } from 'prosemirror-model';
import { Command, EditorState, Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { setBlockType } from 'prosemirror-commands';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { highlightCode } from '../code-languages';
import { codeBody } from '../markdown-converter';
import { schema } from '../schema';

/** What code blocks need from the app: the Angular-side language picker and context menu. */
export interface CodeBlockContext {
  /** Opens the language picker for the code block at `pos`, under `anchor`. */
  pickLanguage(view: EditorView, pos: number, anchor: HTMLElement): void;
  /** Opens the context menu for the code block at `pos`. */
  contextMenu(event: MouseEvent, view: EditorView, pos: number): void;
}

interface CodeBlockPluginState {
  context: CodeBlockContext;
  decorations: DecorationSet;
}

export const codeBlockPluginKey = new PluginKey<CodeBlockPluginState>('code-blocks');

export function codeBlockContext(view: EditorView): CodeBlockContext | undefined {
  return codeBlockPluginKey.getState(view.state)?.context;
}

function highlightDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== schema.nodes['code_block']) return true;
    const { text, params, offset } = codeBody(node);
    const start = pos + 1 + offset;
    for (const token of highlightCode(text, params)) {
      decorations.push(Decoration.inline(start + token.from, start + token.to, { class: token.className }));
    }
    // Revealed fences, muted like other syntax.
    if (offset) {
      const end = pos + 1 + node.content.size;
      const all = node.textContent;
      decorations.push(Decoration.inline(pos + 1, start - 1, { class: 'md-syntax' }));
      decorations.push(Decoration.inline(end - (all.length - all.lastIndexOf('\n') - 1), end, { class: 'md-syntax' }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Syntax highlighting as inline decorations — the node stays plain `text*`,
 * so the Markdown round trip never sees it — plus the code block's context
 * menu and a handle on the app for its language picker.
 */
export function codeBlockPlugin(context: CodeBlockContext): Plugin<CodeBlockPluginState> {
  return new Plugin<CodeBlockPluginState>({
    key: codeBlockPluginKey,
    state: {
      init: (_, state) => ({ context, decorations: highlightDecorations(state.doc) }),
      // ponytail: re-highlights every block on each edit; cache per block if long notes get sluggish.
      apply: (tr, value) => (tr.docChanged ? { context, decorations: highlightDecorations(tr.doc) } : value),
    },
    props: {
      decorations: (state) => codeBlockPluginKey.getState(state)?.decorations,
      handleDOMEvents: {
        contextmenu: (view, event) => {
          const pos = codeBlockPosAt(view, event);
          if (pos === null) return false;
          context.contextMenu(event, view, pos);
          return true;
        },
      },
    },
  });
}

/** The position of the code block under the pointer of `event`, or null. */
function codeBlockPosAt(view: EditorView, event: MouseEvent): number | null {
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return null;
  const $pos = view.state.doc.resolve(hit.pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type === schema.nodes['code_block']) return $pos.before(depth);
  }
  return null;
}

/** Sets the fence language of the code block at `pos` (empty for plain text). */
export function setCodeBlockLanguage(view: EditorView, pos: number, params: string): void {
  const node = view.state.doc.nodeAt(pos);
  if (node?.type !== schema.nodes['code_block']) return;
  const tr = view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, params });
  // While its fences show, the opening one is where the language lives.
  const { offset } = codeBody(node);
  if (offset) tr.insertText(/^(`+|~+)/.exec(node.textContent)![0] + params, pos + 1, pos + offset);
  view.dispatch(tr);
}

/** Turns the current block into a code block with the fence language `params`, or relabels the code block it's in. */
export function setCodeBlock(view: EditorView, params: string): boolean {
  const { $from } = view.state.selection;
  if ($from.parent.type === schema.nodes['code_block']) {
    setCodeBlockLanguage(view, $from.before(), params);
    return true;
  }
  return setBlockType(schema.nodes['code_block'], { params })(view.state, view.dispatch, view);
}

/** Turns the code block at `pos` back into a paragraph, keeping its text (line breaks become hard breaks). */
export function codeBlockToParagraph(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos);
  if (node?.type !== schema.nodes['code_block']) return;
  const content = codeBody(node)
    .text.split('\n')
    .flatMap((line, i) => [...(i > 0 ? [schema.nodes['hard_break'].create()] : []), ...(line ? [schema.text(line)] : [])]);
  view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, schema.nodes['paragraph'].create(null, content)));
}

/** The unit Tab adds before a line in a code block. */
const INDENT = '  ';

/**
 * Tab / Shift-Tab in a code block: indent or outdent every line the selection
 * touches. Outside a code block it declines, so list nesting gets the key.
 */
export function indentCodeLines(outdent: boolean): Command {
  return (state: EditorState, dispatch) => {
    const { $from, $to } = state.selection;
    if ($from.parent.type !== schema.nodes['code_block'] || !$from.sameParent($to)) return false;
    if (!dispatch) return true;
    const text = $from.parent.textContent;
    const start = $from.start();
    const lineStarts: number[] = [];
    for (let at = text.lastIndexOf('\n', $from.parentOffset - 1) + 1; ; ) {
      lineStarts.push(at);
      const next = text.indexOf('\n', at);
      if (next === -1 || next >= $to.parentOffset) break;
      at = next + 1;
    }
    const tr = state.tr;
    for (const at of lineStarts.reverse()) {
      if (!outdent) {
        tr.insertText(INDENT, start + at);
        continue;
      }
      const leading = /^(?: {1,2}|\t)/.exec(text.slice(at))?.[0];
      if (leading) tr.delete(start + at, start + at + leading.length);
    }
    // Swallow the key even when there was nothing to outdent, so focus stays in the editor.
    if (tr.docChanged) dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Tab at the start of a paragraph makes it indented code, as a tab there would read on reload. */
export const indentedCodeOnTab: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.parentOffset !== 0 || $cursor.parent.type !== schema.nodes['paragraph']) return false;
  return setBlockType(schema.nodes['code_block'], { fence: '' })(state, dispatch);
};

/**
 * Enter at the end of a paragraph that reads ```` ```lang ```` turns it into a
 * code block in that language. (An input rule can't do this: Enter never
 * reaches `handleTextInput`. Space is covered by an input rule.)
 */
export const codeFenceOnEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== schema.nodes['paragraph'] || $from.parentOffset !== $from.parent.content.size) return false;
  const match = /^```([^\s`]*)$/.exec($from.parent.textContent);
  if (!match) return false;
  if (dispatch) {
    const start = $from.start();
    const tr = state.tr.delete(start, $from.pos).setBlockType(start, start, schema.nodes['code_block'], { params: match[1] });
    dispatch(tr.setSelection(TextSelection.create(tr.doc, start)).scrollIntoView());
  }
  return true;
};
