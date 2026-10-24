import { Fragment, Mark, Node as PMNode } from 'prosemirror-model';
import { Command, EditorState, NodeSelection, Plugin, PluginKey, TextSelection, Transaction } from 'prosemirror-state';
import { Mapping, findWrapping, liftTarget } from 'prosemirror-transform';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { openUrl } from '@tauri-apps/plugin-opener';
import { codeBody, codeFence, parseMarkdown, serializeMarkdown } from '../markdown-converter';
import { schema } from '../schema';

/*
 * Live-preview editing: the construct under the cursor is swapped for its raw
 * Markdown, which the user edits as plain text, and parsed back when the
 * cursor leaves. Inline syntax becomes `md_raw` text (saved verbatim), a
 * heading's `## ` or a quote line's `> ` becomes `md_prefix` text (never
 * saved; the block's type says the same), and a code block's fences become
 * part of its text (`revealed`). Either way the saved Markdown doesn't change.
 *
 * Unfolding and refolding stay out of undo history, and edit the document
 * character by character rather than replacing the construct, so undo steps
 * taken inside it still map onto the text afterwards.
 */

const rawMark = schema.marks['md_raw'];
const prefixMark = schema.marks['md_prefix'];
const { paragraph, heading, blockquote, image } = schema.nodes;
const codeBlock = schema.nodes['code_block'];
const hardBreak = schema.nodes['hard_break'];
const rule = schema.nodes['horizontal_rule'];

/** Marks whose delimiters reveal. */
const INLINE_MARKS = ['strong', 'em', 'strike', 'highlight', 'comment', 'code', 'link', 'wikilink'].map((name) => schema.marks[name]);
/** Characters the serializer backslash-escapes in plain text. */
const ESCAPABLE = /[`*\\~[\]_]/;
/** The delimiters in raw text, shown muted. */
const SYNTAX = /\\(?=\S)|[*_~`]+|={2}|%{2}|!?\[|\]\(.*?\)|\]|^-{3,}$/g;

export const syntaxRevealKey = new PluginKey<DecorationSet>('syntax-reveal');

const isRaw = (node: PMNode): boolean => !!rawMark.isInSet(node.marks);
const isImageSource = (node: PMNode | null | undefined): boolean =>
  !!node && node.marks.some((mark) => mark.type === rawMark && mark.attrs['image']);

/** End of the revealed prefix at the start of `block`, counting anything typed in front of it; 0 if it has none. */
function prefixEnd(block: PMNode): number {
  let end = 0;
  for (let i = 0; i < block.childCount; i++) {
    const child = block.child(i);
    if (!child.isText) return 0;
    end += child.nodeSize;
    if (prefixMark.isInSet(child.marks)) return end;
  }
  return 0;
}

function quoteDepth(doc: PMNode, pos: number): number {
  const $pos = doc.resolve(pos);
  let depth = 0;
  for (let d = $pos.depth; d > 0 && $pos.node(d).type === blockquote; d--) depth++;
  return depth;
}

/** The `> ` and `## ` the textblock at `pos` is written with. */
function expectedPrefix(doc: PMNode, pos: number): string {
  const block = doc.nodeAt(pos)!;
  return '> '.repeat(quoteDepth(doc, pos)) + (block.type === heading ? '#'.repeat(block.attrs['level']) + ' ' : '');
}

// --- Character-level edits --------------------------------------------------

/** A character of text, or an inline leaf (image, hard break). */
type Unit = string | PMNode;

function units(content: Fragment): Unit[] {
  const out: Unit[] = [];
  content.forEach((node) => (node.isText ? out.push(...node.text!.split('')) : out.push(node)));
  return out;
}

function sameUnit(a: Unit, b: Unit): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.type === b.type && JSON.stringify(a.attrs) === JSON.stringify(b.attrs);
}

/** Index pairs of a longest common subsequence of `a` and `b`. */
function commonUnits(a: Unit[], b: Unit[]): [number, number][] {
  // ponytail: O(n·m) table over the changed middle only; past a million cells everything is replaced instead.
  if (a.length * b.length > 1_000_000) return [];
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = sameUnit(a[i], b[j]) ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (sameUnit(a[i], b[j])) pairs.push([i++, j++]);
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

function toNodes(run: Unit[]): PMNode[] {
  const nodes: PMNode[] = [];
  let text = '';
  for (const unit of run) {
    if (typeof unit === 'string') {
      text += unit;
      continue;
    }
    if (text) nodes.push(schema.text(text));
    text = '';
    nodes.push(unit.mark(Mark.none));
  }
  if (text) nodes.push(schema.text(text));
  return nodes;
}

/**
 * Turns the content of the textblock at `pos` into `target`, replacing only
 * the characters that differ and then setting the marks, so positions inside
 * unchanged text map straight through.
 */
function morph(tr: Transaction, pos: number, target: Fragment): void {
  const start = pos + 1;
  const old = units(tr.doc.nodeAt(pos)!.content);
  const next = units(target);
  let head = 0;
  while (head < old.length && head < next.length && sameUnit(old[head], next[head])) head++;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    sameUnit(old[old.length - 1 - tail], next[next.length - 1 - tail])
  ) tail++;
  const a = old.slice(head, old.length - tail);
  const b = next.slice(head, next.length - tail);

  const edits: { from: number; to: number; insert: Unit[] }[] = [];
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...commonUnits(a, b), [a.length, b.length]]) {
    if (mi > i || mj > j) edits.push({ from: i, to: mi, insert: b.slice(j, mj) });
    i = mi + 1;
    j = mj + 1;
  }
  // Last first, so the earlier offsets still hold.
  for (const edit of edits.reverse()) {
    const from = start + head + edit.from;
    tr.replaceWith(from, start + head + edit.to, toNodes(edit.insert));
  }

  const content = tr.doc.nodeAt(pos)!.content;
  if (content.eq(target)) return;
  tr.removeMark(start, start + content.size, null);
  target.forEach((node, offset) => node.marks.forEach((mark) => tr.addMark(start + offset, start + offset + node.nodeSize, mark)));
}

// --- Unfolding ----------------------------------------------------------------

const START = '';
const END = '';

/** The Markdown the serializer writes for content offsets `from`–`to` of `block`, in context. */
function rawMarkdown(block: PMNode, from: number, to: number): string {
  const content = block.content;
  const fenced = content
    .cut(0, from)
    .append(Fragment.from(schema.text(START)))
    .append(content.cut(from, to))
    .append(Fragment.from(schema.text(END)))
    .append(content.cut(to));
  const markdown = serializeMarkdown(schema.node('doc', null, [paragraph.create(null, fenced)]));
  return markdown.slice(markdown.indexOf(START) + 1, markdown.indexOf(END));
}

function rawNodes(raw: string, imageSource = false): PMNode[] {
  const mark = rawMark.create({ image: imageSource });
  return raw
    .split('\n')
    .flatMap((line, i) => [...(i ? [hardBreak.create(null, null, [mark])] : []), ...(line ? [schema.text(line, [mark])] : [])]);
}

/**
 * The stretch of `block`'s content (offsets) to reveal for a selection of
 * offsets `from`–`to`: every mark touching it, grown until no mark crosses
 * its ends, plus an escaped character beside the cursor. `image` when it's
 * just an image, whose source is shown beside it rather than in its place.
 */
function inlineSpan(block: PMNode, from: number, to: number): { from: number; to: number; image: boolean } | null {
  const children: { node: PMNode; from: number; to: number }[] = [];
  block.forEach((node, offset) => children.push({ node, from: offset, to: offset + node.nodeSize }));
  const runOf = (index: number, has: (node: PMNode) => boolean): [number, number] => {
    let first = index;
    let last = index;
    while (first > 0 && has(children[first - 1].node)) first--;
    while (last < children.length - 1 && has(children[last + 1].node)) last++;
    // An image's source stands for the image after it.
    if (has === isRaw && isImageSource(children[last].node) && children[last + 1]?.node.type === image) last++;
    return [children[first].from, children[last].to];
  };

  let lo = Infinity;
  let hi = -Infinity;
  const grow = ([a, b]: [number, number]) => {
    const grew = a < lo || b > hi;
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
    return grew;
  };
  const constructsOf = (index: number): [number, number][] => {
    const { node } = children[index];
    const runs = INLINE_MARKS.flatMap((type) => {
      const mark = type.isInSet(node.marks);
      return mark ? [runOf(index, (n) => mark.isInSet(n.marks))] : [];
    });
    if (isRaw(node)) runs.push(runOf(index, isRaw));
    return runs;
  };

  const empty = from === to;
  children.forEach((child, index) => {
    if (empty ? child.from > from || child.to < from : child.from >= to || child.to <= from) return;
    constructsOf(index).forEach(grow);
    if (child.node.type === image && !child.node.marks.length) grow([child.from, child.to]);
    if (empty && child.node.isText && !child.node.marks.length) {
      for (const at of [from - 1, from]) {
        if (at >= child.from && at < child.to && ESCAPABLE.test(child.node.text![at - child.from])) grow([at, at + 1]);
      }
    }
  });
  if (lo === Infinity) return null;

  // Nested and overlapping marks reveal together.
  for (let grew = true; grew; ) {
    grew = false;
    children.forEach((child, index) => {
      if (child.from < hi && child.to > lo) constructsOf(index).forEach((run) => (grew = grow(run) || grew));
    });
  }

  const inside = children.filter((child) => child.from < hi && child.to > lo);
  // An image counts as revealed when its source sits just before it, inside the span or not.
  const alreadyRaw = children.every(
    (child, i) =>
      !(child.from < hi && child.to > lo) || isRaw(child.node) || (child.node.type === image && isImageSource(children[i - 1]?.node)),
  );
  if (alreadyRaw) return null;
  const imageOnly = inside.length === 1 && inside[0].node.type === image;
  return { from: lo, to: hi, image: imageOnly };
}

function unfoldInline(tr: Transaction, pos: number): void {
  const block = tr.doc.nodeAt(pos)!;
  const start = pos + 1;
  const selection = tr.selection;
  const span = inlineSpan(block, selection.from - start, selection.to - start);
  if (!span) return;
  const raw = rawMarkdown(block, span.from, span.to);
  const content = block.content;
  const inside = content.cut(span.from, span.to);
  let plain = true;
  inside.forEach((node) => (plain &&= node.isText && !node.marks.length));
  // Nothing to show, e.g. an underscore inside a word, which isn't escaped.
  if (plain && raw === inside.textBetween(0, inside.size)) return;

  const target = content
    .cut(0, span.from)
    .append(Fragment.from(rawNodes(raw, span.image)))
    .append(content.cut(span.image ? span.from : span.to));
  const steps = tr.steps.length;
  morph(tr, pos, target);
  const mapping = tr.mapping.slice(steps);
  // A cursor at the start stays outside the opening delimiter.
  const map = (p: number) => mapping.map(p, p === start + span.from ? -1 : 1);
  tr.setSelection(TextSelection.create(tr.doc, map(selection.anchor), map(selection.head)));
}

function unfoldPrefix(tr: Transaction, pos: number): void {
  const prefix = expectedPrefix(tr.doc, pos);
  if (prefix && !prefixEnd(tr.doc.nodeAt(pos)!)) tr.insert(pos + 1, schema.text(prefix, [prefixMark.create()]));
}

function unfoldCode(tr: Transaction, pos: number): void {
  const node = tr.doc.nodeAt(pos)!;
  if (node.attrs['revealed']) {
    // The opening fence is the language while it shows.
    const { params, offset } = codeBody(node);
    if (offset && params !== node.attrs['params']) tr.setNodeMarkup(pos, null, { ...node.attrs, params });
    return;
  }
  // Indented code has no fences to show.
  if (!node.attrs['fence'] && !node.attrs['params']) return;
  const text = node.textContent;
  const fence = codeFence(node.attrs['fence'], text);
  const open = fence + node.attrs['params'] + '\n';
  const start = pos + 1;
  const { anchor, head } = tr.selection;
  tr.setNodeMarkup(pos, null, { ...node.attrs, revealed: true });
  tr.insertText('\n' + fence, start + text.length);
  tr.insertText(open, start);
  tr.setSelection(TextSelection.create(tr.doc, anchor + open.length, head + open.length));
}

function unfoldRule(tr: Transaction, pos: number): void {
  const markup: string = tr.doc.nodeAt(pos)!.attrs['markup'];
  tr.replaceWith(pos, pos + 1, paragraph.create(null, schema.text(markup, [rawMark.create()])));
  tr.setSelection(TextSelection.create(tr.doc, pos + 1 + markup.length));
}

function unfold(tr: Transaction): void {
  const selection = tr.selection;
  // A selected image shows only a focus ring; its source shows beside the cursor, or through `revealImageSource`.
  if (selection instanceof NodeSelection) {
    if (selection.node.type === rule) unfoldRule(tr, selection.from);
    return;
  }
  const { $from, $to } = selection;
  if (!(selection instanceof TextSelection) || !$from.sameParent($to) || !$from.parent.isTextblock) return;
  const pos = $from.before();
  if ($from.parent.type === codeBlock) return unfoldCode(tr, pos);
  unfoldPrefix(tr, pos);
  unfoldInline(tr, pos);
}

// --- Refolding ----------------------------------------------------------------

/** Parses the textblock at `pos` back from the Markdown it now reads as. */
function refoldTextblock(tr: Transaction, pos: number): void {
  const block = tr.doc.nodeAt(pos)!;
  const parsed = parseMarkdown(serializeMarkdown(schema.node('doc', null, [block])));
  const $pos = tr.doc.resolve(pos);
  const index = $pos.index();
  const only = parsed.childCount === 1 ? parsed.firstChild! : null;
  if (only?.isTextblock && only.type !== codeBlock && $pos.parent.canReplaceWith(index, index + 1, only.type)) {
    if (!block.hasMarkup(only.type, only.attrs)) tr.setNodeMarkup(pos, only.type, only.attrs);
    morph(tr, pos, only.content);
  } else if ($pos.parent.canReplace(index, index + 1, parsed.content)) {
    // `---` became a rule, `- a` a list, …
    tr.replaceWith(pos, pos + block.nodeSize, parsed.content);
  } else {
    // What can't stand here stays literal text.
    tr.removeMark(pos + 1, pos + block.nodeSize - 1, rawMark).removeMark(pos + 1, pos + block.nodeSize - 1, prefixMark);
  }
}

function refoldCode(tr: Transaction, pos: number): void {
  const node = tr.doc.nodeAt(pos)!;
  const { text, params, fence, offset } = codeBody(node);
  const start = pos + 1;
  if (offset) {
    tr.delete(start + offset + text.length, start + node.content.size);
    tr.delete(start, start + offset);
  }
  tr.setNodeMarkup(pos, null, { ...node.attrs, params, fence, revealed: false });
}

/** Whether the textblock at `pos` holds revealed syntax the selection (`from`–`to`) has left. */
function isStale(doc: PMNode, block: PMNode, pos: number, from: number, to: number): boolean {
  const start = pos + 1;
  let hasPrefix = false;
  let stale = false;
  let run: [number, number] | null = null;
  const endRun = () => {
    if (run && !(from <= start + run[1] && to >= start + run[0])) stale = true;
    run = null;
  };
  block.forEach((child, offset, index) => {
    if (prefixMark.isInSet(child.marks)) hasPrefix = true;
    const end = offset + child.nodeSize;
    if (isRaw(child) || (child.type === image && isImageSource(block.maybeChild(index - 1)))) {
      run = run ? [run[0], end] : [offset, end];
    } else endRun();
  });
  endRun();
  const inBlock = from >= start && to <= pos + block.nodeSize - 1;
  return stale || (hasPrefix && (!inBlock || !expectedPrefix(doc, pos)));
}

function refold(tr: Transaction): void {
  const { from, to } = tr.selection;
  const stale: { pos: number; code: boolean }[] = [];
  tr.doc.descendants((node, pos) => {
    if (node.type === codeBlock) {
      if (node.attrs['revealed'] && !(from > pos && to < pos + node.nodeSize)) stale.push({ pos, code: true });
      return false;
    }
    if (!node.isTextblock) return true;
    if (isStale(tr.doc, node, pos, from, to)) stale.push({ pos, code: false });
    return false;
  });
  for (const { pos, code } of stale.reverse()) (code ? refoldCode : refoldTextblock)(tr, pos);
}

// --- Edits to revealed syntax -----------------------------------------------

/**
 * The user edited a revealed `## ` / `> ` prefix: the block follows the text
 * (a level, a paragraph, in or out of a quote), and what no longer reads as
 * a prefix becomes literal text. If instead the block changed some other way
 * (e.g. "Turn into"), the prefix is rewritten to match it.
 */
function syncPrefix(tr: Transaction, oldState: EditorState, mapping: Mapping): void {
  const $old = oldState.selection.$from;
  const oldEnd = $old.depth ? prefixEnd($old.parent) : 0;
  if (!oldEnd) return;
  const oldPos = $old.before();
  const mapped = mapping.mapResult(oldPos, 1);
  const block = tr.doc.nodeAt(mapped.pos);
  if (mapped.deleted || !block?.isTextblock || block.type === codeBlock) return;

  const pos = mapped.pos;
  const start = pos + 1;
  const end = prefixEnd(block);
  const text = block.textBetween(0, end);
  if (text === $old.parent.textBetween(0, oldEnd)) {
    const expected = expectedPrefix(tr.doc, pos);
    if (expected !== expectedPrefix(oldState.doc, oldPos)) {
      tr.replaceWith(start, start + end, expected ? schema.text(expected, [prefixMark.create()]) : []);
    }
    return;
  }

  const [, quotePart, rest] = /^((?:>[ \t]?)*)(.*)$/s.exec(text)!;
  const $pos = tr.doc.resolve(pos);
  const canBeHeading = $pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, heading);
  const level = (canBeHeading && /^(#{1,6})[ \t]+$/.exec(rest)?.[1].length) || 0;
  const keep = level || !rest ? end : quotePart.length;
  tr.removeMark(start, start + end, prefixMark);
  if (keep) tr.addMark(start, start + keep, prefixMark.create());
  if (level && !block.hasMarkup(heading, { level })) tr.setNodeMarkup(pos, heading, { level });
  else if (!level && block.type === heading) tr.setNodeMarkup(pos, paragraph);

  const quotes = (quotePart.match(/>/g) ?? []).length;
  let inner = start;
  for (let depth = quoteDepth(tr.doc, pos); depth !== quotes; depth += depth > quotes ? -1 : 1) {
    const range = tr.doc.resolve(inner).blockRange();
    const steps = tr.steps.length;
    if (depth > quotes) {
      const target = range && liftTarget(range);
      if (target == null) break;
      tr.lift(range!, target);
    } else {
      const wrapping = range && findWrapping(range, blockquote);
      if (!wrapping) break;
      tr.wrap(range!, wrapping);
    }
    inner = tr.mapping.slice(steps).map(inner);
  }
}

/** An image deleted while its source showed takes the source with it. */
function dropOrphanedSources(tr: Transaction, oldState: EditorState, mapping: Mapping): void {
  const orphans: [number, number][] = [];
  oldState.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    node.forEach((child, offset, index) => {
      if (!isImageSource(child) || node.maybeChild(index + 1)?.type !== image) return;
      const imagePos = pos + 1 + offset + child.nodeSize;
      if (!mapping.mapResult(imagePos, 1).deletedAfter) return;
      const from = mapping.map(pos + 1 + offset, 1);
      const to = mapping.map(imagePos, -1);
      if (from < to) orphans.push([from, to]);
    });
    return false;
  });
  for (const [from, to] of orphans.reverse()) tr.delete(from, to);
}

// --- Plugin -------------------------------------------------------------------

function syntaxDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    node.forEach((child, offset) => {
      if (!child.isText || !isRaw(child)) return;
      for (const match of child.text!.matchAll(SYNTAX)) {
        const from = pos + 1 + offset + match.index;
        decorations.push(Decoration.inline(from, from + match[0].length, { class: 'md-syntax' }));
      }
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** The link at `pos`: a link mark's `href` or a wikilink's target, or one written in revealed Markdown. */
function linkAt(doc: PMNode, pos: number): { href: string; wiki: boolean } | null {
  const $pos = doc.resolve(pos);
  for (const { node, offset } of [$pos.parent.childAfter($pos.parentOffset), $pos.parent.childBefore($pos.parentOffset)]) {
    if (!node) continue;
    const link = schema.marks['link'].isInSet(node.marks);
    if (link) return { href: link.attrs['href'], wiki: false };
    const wikilink = schema.marks['wikilink'].isInSet(node.marks);
    if (wikilink) return { href: wikilink.attrs['target'], wiki: true };
    if (!node.isText || !isRaw(node)) continue;
    const at = $pos.parentOffset - offset;
    for (const match of node.text!.matchAll(/\[\[([^\]|]+)[^\]]*\]\]|\[[^\]]*\]\(\s*<?([^)\s>]+)[^)]*\)/g)) {
      if (match.index <= at && at <= match.index + match[0].length) {
        return match[1] ? { href: match[1], wiki: true } : { href: match[2], wiki: false };
      }
    }
  }
  return null;
}

/**
 * `openFile` opens a Ctrl/Cmd-clicked link to a file in the vault (anything
 * but a web link), and `openNote` a `[[link]]` to a note, by its target.
 */
export function syntaxRevealPlugin(
  openFile?: (href: string) => void,
  openNote?: (target: string) => void,
): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: syntaxRevealKey,
    state: {
      init: (_, state) => syntaxDecorations(state.doc),
      apply: (tr, value) => (tr.docChanged ? syntaxDecorations(tr.doc) : value),
    },
    appendTransaction(transactions, oldState, state) {
      if (
        !transactions.some((tr) => tr.docChanged || tr.selectionSet) ||
        transactions.every((tr) => tr.getMeta(syntaxRevealKey)) ||
        // Rewriting text under an IME composition breaks it; the next selection change catches up.
        transactions.some((tr) => tr.getMeta('composition') !== undefined)
      ) return null;
      const mapping = new Mapping();
      transactions.forEach((tr) => mapping.appendMapping(tr.mapping));
      const tr = state.tr;
      dropOrphanedSources(tr, oldState, mapping);
      syncPrefix(tr, oldState, mapping);
      refold(tr);
      unfold(tr);
      return tr.docChanged ? tr.setMeta('addToHistory', false).setMeta(syntaxRevealKey, true) : null;
    },
    props: {
      decorations: (state) => {
        const set = syntaxRevealKey.getState(state)!;
        // A line of bare `#`s under the cursor already reads as the heading it's about to become.
        const { $from, empty } = state.selection;
        const block = $from.parent;
        const hashes = empty && block.type === paragraph && /^#{1,6}$/.exec(block.textBetween(prefixEnd(block), block.content.size));
        if (!hashes) return set;
        return set.add(state.doc, [Decoration.node($from.before(), $from.after(), { class: `md-h${hashes[0].length}` })]);
      },
      // A typed `*`, `_`, `` ` ``… is Markdown being written, not a literal to escape:
      // it goes in as raw text, and parses with the rest of the line once the cursor leaves.
      handleTextInput: (view, from, to, text) => {
        const $from = view.state.doc.resolve(from);
        if (!ESCAPABLE.test(text) || $from.parent.type.spec.code || $from.marks().some((mark) => mark.type.spec.code)) {
          return false;
        }
        view.dispatch(view.state.tr.insertText(text, from, to).addMark(from, from + text.length, rawMark.create()));
        return true;
      },
      handleDOMEvents: {
        // Ctrl/Cmd-click opens a link, before the click can reveal it.
        mousedown: (view, event) => {
          if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
          const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
          const link = hit && linkAt(view.state.doc, hit.pos);
          if (link?.wiki && openNote) {
            event.preventDefault();
            openNote(link.href);
            return true;
          }
          const href = link && !link.wiki ? link.href : null;
          const web = href && /^(https?:|mailto:)/i.test(href);
          if (!href || (!web && (!openFile || /^[a-z][a-z0-9+.-]*:/i.test(href)))) return false;
          event.preventDefault();
          if (web) void openUrl(href);
          else openFile?.(href);
          return true;
        },
      },
    },
  });
}

/** Shows the Markdown source of the image at `pos`, selected. */
export function revealImageSource(view: EditorView, pos: number): void {
  const $pos = view.state.doc.resolve(pos);
  // Which of its block's images it is, to find it again once its source is in front of it.
  let nth = 0;
  $pos.parent.forEach((child, offset) => void (child.type === image && offset < $pos.parentOffset && nth++));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  const { $from } = view.state.selection;
  let seen = 0;
  $from.parent.forEach((child, offset, index) => {
    const source = $from.parent.maybeChild(index - 1);
    if (child.type !== image || seen++ !== nth || !isImageSource(source)) return;
    const end = $from.start() + offset;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end - source!.nodeSize, end)));
  });
  view.focus();
}

/**
 * Enter on a quote line holding nothing but its revealed `> `: leave the
 * quote (one level), as Enter on an empty quote line does.
 */
export const exitEmptyQuoteLine: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.depth < 2 || $cursor.node(-1).type !== blockquote) return false;
  const block = $cursor.parent;
  if (!prefixEnd(block) || prefixEnd(block) !== block.content.size) return false;
  if (dispatch) {
    const start = $cursor.start();
    const tr = state.tr.delete(start, $cursor.end());
    const range = tr.doc.resolve(start).blockRange();
    const target = range && liftTarget(range);
    if (range && target != null) tr.lift(range, target);
    const inner = tr.mapping.slice(1).map(start);
    const prefix = expectedPrefix(tr.doc, tr.doc.resolve(inner).before());
    if (prefix) tr.insert(inner, schema.text(prefix, [prefixMark.create()]));
    dispatch(tr.scrollIntoView());
  }
  return true;
};
