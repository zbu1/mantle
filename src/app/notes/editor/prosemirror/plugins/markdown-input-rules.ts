import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { Attrs, Fragment, MarkType, Node as PMNode } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import { schema } from '../schema';

/**
 * Applies a mark to the text captured by the last group of `regexp`, stripping
 * the surrounding markdown delimiters.
 *
 * `{ inCodeMark: false }` is required: prosemirror-inputrules defaults
 * `inCodeMark` to true, so without it these rules would fire inside inline code
 * spans. (Code *blocks* are already excluded by the `inCode: false` default.)
 */
function markInputRule(
  regexp: RegExp,
  markType: MarkType,
  getAttrs?: (match: RegExpMatchArray) => Attrs | null
): InputRule {
  return new InputRule(
    regexp,
    (state, match, start, end) => {
      const captureGroup = match[match.length - 1];
      const fullMatch = match[0];
      if (!captureGroup) return null;

      // The `(?:^|\s)` prefix may have consumed a leading space; keep it.
      const startSpaces = fullMatch.search(/\S/);
      const textStart = start + fullMatch.indexOf(captureGroup);
      const textEnd = textStart + captureGroup.length;
      const markStart = start + startSpaces;

      const tr = state.tr;
      if (textEnd < end) tr.delete(textEnd, end);
      if (textStart > markStart) tr.delete(markStart, textStart);
      tr.addMark(
        markStart,
        markStart + captureGroup.length,
        markType.create(getAttrs?.(match) ?? undefined)
      );
      tr.removeStoredMark(markType);
      return tr;
    },
    { inCodeMark: false }
  );
}

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
  (state, _match, start, end) => {
    const tr = state.tr.insert(start - 1, schema.nodes['horizontal_rule'].create());
    tr.delete(tr.mapping.map(start), tr.mapping.map(end));
    return tr;
  }
);

const blockquoteRule = wrappingInputRule(/^\s*>\s$/, schema.nodes['blockquote']);

const orderedListRule = wrappingInputRule(
  /^(\d+)[.)]\s$/,
  schema.nodes['ordered_list'],
  (match) => ({ order: +match[1] }),
  // `node` is the preceding sibling list: typing "2. " after a "1. " item
  // continues that list instead of starting a new one.
  (match, node) => node.childCount + node.attrs['order'] === +match[1]
);

const bulletListRule = wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes['bullet_list']);

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
    null,
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

/**
 * Two capture groups (label and href) don't fit markInputRule's single-group
 * shape. Known limitation: a literal `)` inside the URL truncates the match.
 */
const linkRule = new InputRule(
  /(?:^|\s)\[([^\]]+)\]\(([^)]+)\)$/,
  (state, match, start, end) => {
    const [fullMatch, text, href] = match;
    const linkType = schema.marks['link'];
    const textStart = start + fullMatch.indexOf('[');

    const tr = state.tr.delete(textStart, end).insertText(text, textStart);
    tr.addMark(textStart, textStart + text.length, linkType.create({ href }));
    tr.removeStoredMark(linkType);
    return tr;
  },
  { inCodeMark: false }
);

// The `(?:^|\s)` prefix requires the opening delimiter to follow start-of-block
// or whitespace, which is what keeps `my_variable_name` from italicizing.
// Trade-off: emphasis directly after punctuation, as in `(_word_)`, won't fire.
const boldStarRule = markInputRule(
  /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/,
  schema.marks['strong']
);
const boldUnderscoreRule = markInputRule(
  /(?:^|\s)(__(?!\s+__)((?:[^_]+))__(?!\s+__))$/,
  schema.marks['strong'],
  () => ({ markup: '__' })
);
const strikeRule = markInputRule(
  /(?:^|\s)(~~(?!\s+~~)([^~]+)~~(?!\s+~~))$/,
  schema.marks['strike']
);
const codeRule = markInputRule(/(?:^|\s)(`([^`]+)`)$/, schema.marks['code']);
const italicStarRule = markInputRule(
  /(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))$/,
  schema.marks['em']
);
const italicUnderscoreRule = markInputRule(
  /(?:^|\s)(_(?!\s+_)((?:[^_]+))_(?!\s+_))$/,
  schema.marks['em'],
  () => ({ markup: '_' })
);

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
      horizontalRuleRule,
      blockquoteRule,
      orderedListRule,
      bulletListRule,
      taskItemRule,
      boldStarRule,
      boldUnderscoreRule,
      strikeRule,
      codeRule,
      italicStarRule,
      italicUnderscoreRule,
      linkRule,
    ],
  });
}
