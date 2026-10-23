import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { Fragment, Node as PMNode } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import { schema } from '../schema';

const { paragraph, code_block: codeBlock } = schema.nodes;

/*
 * Block rules only. Inline syntax (`**bold**`, `[text](url)`, …) needs no
 * rules: its delimiters are typed as raw Markdown, which parses once the
 * cursor leaves (see syntax-reveal-plugin).
 */

const headingRule = textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes['heading'], (match) => ({
  level: match[1].length,
}));

// ```lang then Space. Enter never reaches handleTextInput, so ```lang then
// Enter is `codeFenceOnEnter` in the keymap instead. Waiting for one of the two
// (rather than converting on the third backtick) is what lets a language be typed.
const codeFenceRule = textblockTypeInputRule(/^```([^\s`]*)\s$/, schema.nodes['code_block'], (match) => ({
  params: match[1],
}));

/**
 * Inserts the rule *before* the current textblock rather than replacing it, so
 * the (now emptied) block remains after it as a cursor landing spot.
 */
const horizontalRuleRule = new InputRule(
  /^(?:---|\*\*\*|___)$/,
  (state, match, start, end) => {
    const tr = state.tr.insert(start - 1, schema.nodes['horizontal_rule'].create({ markup: match[0] }));
    tr.delete(tr.mapping.map(start), tr.mapping.map(end));
    return tr;
  }
);

/** Four spaces at the start of a paragraph make indented code, as they would on reload. Tab is `indentedCodeOnTab`. */
const indentedCodeRule = new InputRule(/^ {4}$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  const index = $start.index(-1);
  if ($start.parent.type !== paragraph || !$start.node(-1).canReplaceWith(index, index + 1, codeBlock)) return null;
  return state.tr.delete(start, end).setBlockType(start, start, codeBlock, { fence: '' });
});

const blockquoteRule = wrappingInputRule(/^\s*>\s$/, schema.nodes['blockquote']);

const orderedListRule = wrappingInputRule(
  /^(\d+)([.)])\s$/,
  schema.nodes['ordered_list'],
  (match) => ({ order: +match[1], delimiter: match[2] }),
  // `node` is the preceding sibling list: typing "2. " after a "1. " item
  // continues that list instead of starting a new one.
  (match, node) => node.childCount + node.attrs['order'] === +match[1] && node.attrs['delimiter'] === match[2]
);

const bulletListRule = wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes['bullet_list'], (match) => ({
  bullet: match[1],
}));

/**
 * Only promotes a list item that already has its `- ` marker (bare `[ ]` with
 * no marker stays plain text, per the roadmap). `task_list` is a distinct node
 * type from `bullet_list` (not something a `list_item` can nest), so turning
 * one item into a checkbox means splitting the surrounding `bullet_list` into
 * up to three pieces around it, the same shape the Markdown parser produces
 * for a list with both plain and checkbox items.
 */
const taskItemRule = new InputRule(/^\[([ xX]?)\]\s$/, (state, match, start, end) => {
  const checked = /^[xX]$/.test(match[1] ?? '');
  const $before = state.doc.resolve(start);
  if (
    $before.parent.type !== schema.nodes['paragraph'] ||
    $before.node(-1)?.type !== schema.nodes['list_item'] ||
    $before.node(-2)?.type !== schema.nodes['bullet_list'] ||
    $before.index(-1) !== 0
  ) {
    return null;
  }

  const tr = state.tr.delete(start, end);
  const $start = tr.doc.resolve(tr.mapping.map(start));
  const bulletList = $start.node(-2);
  const listItem = $start.node(-1);
  const itemIndex = $start.index(-2);

  const items: PMNode[] = [];
  bulletList.forEach((child) => items.push(child));
  const before = items.slice(0, itemIndex);
  const after = items.slice(itemIndex + 1);

  const taskList = schema.nodes['task_list'].create(
    bulletList.attrs,
    schema.nodes['task_item'].create({ checked }, listItem.content)
  );
  const pieces = [
    ...(before.length ? [bulletList.copy(Fragment.from(before))] : []),
    taskList,
    ...(after.length ? [bulletList.copy(Fragment.from(after))] : []),
  ];

  tr.replaceWith($start.before(-2), $start.after(-2), Fragment.from(pieces));
  return tr;
});

// Not inside a revealed `# ` / `> ` prefix (`md_prefix` is a code mark): a space typed
// after its `#` would otherwise make it a heading again, eating the `#` and leaving a
// prefix that no longer reads as one. Only these two: the other block rules start with
// characters typed as `md_raw` (`*`, `[`, `` ` ``), also a code mark, so they'd never fire.
headingRule.inCodeMark = false;
blockquoteRule.inCodeMark = false;

export function buildMarkdownInputRules(): Plugin {
  return inputRules({
    rules: [
      headingRule,
      codeFenceRule,
      indentedCodeRule,
      horizontalRuleRule,
      blockquoteRule,
      orderedListRule,
      bulletListRule,
      taskItemRule,
    ],
  });
}
