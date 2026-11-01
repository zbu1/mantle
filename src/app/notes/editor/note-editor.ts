import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  input,
  untracked,
  viewChild,
} from '@angular/core';
import { EditorState, Command, Plugin, Selection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Node as ProseMirrorNode, Slice } from 'prosemirror-model';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands, joinTextblockBackward } from 'prosemirror-commands';
import { splitListItem } from 'prosemirror-schema-list';
import { undoInputRule } from 'prosemirror-inputrules';
import { gapCursor } from 'prosemirror-gapcursor';
import { dropCursor } from 'prosemirror-dropcursor';
import { invoke } from '@tauri-apps/api/core';
import { isMobile } from '../../core/tauri-env';

import { ToastState } from '../../shared/toast/toast-state';
import { AttachmentsState, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, attachmentUrl } from '../attachments-state';
import { NotePropertiesState } from '../note-properties-state';
import { NotesState } from '../notes-state';
import { sameProperties } from '../properties';
import { VaultState } from '../vault-state';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { formatError } from '../../core/logger';
import { DialogState } from '../../shared/dialog/dialog-state';
import { EditContextState } from '../../shared/edit-context-state';
import { EditorFocusState } from './editor-focus-state';
import { schema } from './prosemirror/schema';
import { codeBody, parseMarkdown, serializeMarkdown } from './prosemirror/markdown-converter';
import { exitEmptyQuoteLine, revealImageSource, syntaxRevealPlugin, taskMarkerPlugin } from './prosemirror/plugins/syntax-reveal-plugin';
import { mathPlugin, newlineInMathBlock } from './prosemirror/plugins/math-plugin';
import { createSlashMenuPlugin } from './prosemirror/plugins/slash-menu-plugin';
import { buildMarkdownInputRules } from './prosemirror/plugins/markdown-input-rules';
import { trailingParagraphPlugin } from './prosemirror/plugins/trailing-paragraph-plugin';
import { listMarkerPlugin } from './prosemirror/plugins/list-marker-plugin';
import { enterAfterFold, foldedHeadings, headingFoldKey, headingFoldPlugin, setFoldedHeadings } from './prosemirror/plugins/heading-fold-plugin';
import { calloutPlugin } from './prosemirror/plugins/callout-plugin';
import { footnotePlugin } from './prosemirror/plugins/footnote-plugin';
import { tocPlugin } from './prosemirror/plugins/toc-plugin';
import { forgetMisspelling, spellcheckKey, spellcheckPlugin } from './prosemirror/plugins/spellcheck-plugin';
import { SpellcheckState } from './spellcheck-state';
import { OutlineState } from './outline-state';
import { HeadingFoldState, NoteFolds } from './heading-fold-state';
import { findPlugin, findStatus } from './prosemirror/plugins/find-plugin';
import { demoteEmptyLeadingBlock } from './prosemirror/commands/demote-empty-leading-block';
import { liftListItemAtStart } from './prosemirror/commands/lift-list-item-at-start';
import { indentListItems } from './prosemirror/commands/indent-list-items';
import { TaskItemView } from './prosemirror/nodeviews/task-item-view';
import { TableView, cellBelow, goToCell, insertTable, tableMenu, tablePlugins } from './prosemirror/plugins/table-plugin';
import { isInTable } from 'prosemirror-tables';
import { ImageView } from './prosemirror/nodeviews/image-view';
import {
  ImageContext,
  imagePlugin,
  relinkImages,
  removeImage,
  resizeImage,
} from './prosemirror/plugins/image-plugin';

import { CodeLanguagePicker } from './code-language-picker/code-language-picker';
import { CODE_LANGUAGES, languageId } from './prosemirror/code-languages';
import { CodeBlockView } from './prosemirror/nodeviews/code-block-view';
import {
  codeBlockPlugin,
  codeBlockToParagraph,
  codeFenceBackspace,
  codeFenceInput,
  codeFenceOnEnter,
  indentCodeLines,
  indentedCodeOnTab,
  setCodeBlockLanguage,
} from './prosemirror/plugins/code-block-plugin';
import { SlashMenu } from './slash-menu/slash-menu';
import { ADD_PROPERTY_EVENT } from './slash-menu/slash-menu.model';
import { BlockKind, formatSelection, insertHorizontalRule, linkSelection, pastePlainText, turnInto } from './prosemirror/editor-commands';
import { pickImage } from './prosemirror/plugins/image-plugin';
import { ContextMenuAction, ContextMenuItem } from '../../shared/context-menu/context-menu.model';
import { SlashMenuState } from './slash-menu/slash-menu-state';
import { LinkMenu } from './link-menu/link-menu';
import { LinkMenuState, LinkSuggestion } from './link-menu/link-menu-state';
import { WikilinkContext, wikilinkKey, wikilinkPlugin, wikilinkTargets } from './prosemirror/plugins/wikilink-plugin';
import { NoteLinksState } from '../note-links-state';
import { TabsState } from '../tabs-state';
import { isFileLink, linkPath, linkScope, splitLink } from '../links';
import { dirOf } from '../vault-tree.model';

/** Meta on a transaction that brings in an edit made in another pane, so it isn't saved again. */
const OTHER_PANE = 'mantle:other-pane';

/** Asks for one file through the WebView's own picker; null if the user backs out. */
function chooseFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * Where each tab left each note: scroll offset and selection, restored when
 * the tab shows it again. In memory only.
 * ponytail: never pruned; entries are tiny, drop them on tab close if it ever matters.
 */
const viewStates = new Map<string, { scrollTop: number; anchor: number; head: number }>();

function buildEditorKeymap() {
  const keys: Record<string, Command> = {
    ...baseKeymap,
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
    'Mod-b': (_state, _dispatch, view) => !!view && (formatSelection(view, 'strong', '**'), true),
    'Mod-i': (_state, _dispatch, view) => !!view && (formatSelection(view, 'em', '*'), true),
    'Mod-`': (_state, _dispatch, view) => !!view && (formatSelection(view, 'code', '`'), true),
    'Shift-Mod-x': (_state, _dispatch, view) => !!view && (formatSelection(view, 'strike', '~~'), true),
    'Shift-Mod-h': (_state, _dispatch, view) => !!view && (formatSelection(view, 'highlight', '=='), true),
    'Shift-Mod-v': (_state, _dispatch, view) => !!view && (pastePlainText(view), true),
    Enter: chainCommands(
      cellBelow,
      enterAfterFold,
      codeFenceOnEnter,
      newlineInMathBlock,
      exitEmptyQuoteLine,
      splitListItem(schema.nodes['list_item']),
      // The new checkbox starts unchecked, whatever the one it came from.
      splitListItem(schema.nodes['task_item'], { checked: false }),
      baseKeymap['Enter']
    ),
    Tab: chainCommands(goToCell(1), indentCodeLines(false), indentListItems(false), indentedCodeOnTab),
    'Shift-Tab': chainCommands(goToCell(-1), indentCodeLines(true), indentListItems(true)),
    // undoInputRule first, so Backspace right after an auto-conversion restores
    // the literal markdown that triggered it. liftListItemAtStart comes next so
    // Backspace at the very start of a list item just drops its marker in
    // place (cursor and text stay put) rather than merging into the previous
    // item — a second Backspace, now outside the list, falls through to
    // joinTextblockBackward. That runs before the base Backspace handling so
    // merges across list items (or a paragraph merging back into one) join
    // text directly into the neighbouring textblock, instead of baseKeymap's
    // joinBackward nesting a same-type node (e.g. a second paragraph inside
    // the previous list_item, or a new list_item for a plain paragraph) that
    // leaves the marker gone but the content still indented.
    Backspace: chainCommands(
      undoInputRule,
      codeFenceBackspace,
      demoteEmptyLeadingBlock,
      liftListItemAtStart(schema.nodes['list_item']),
      liftListItemAtStart(schema.nodes['task_item']),
      joinTextblockBackward,
      baseKeymap['Backspace']
    ),
  };
  return keymap(keys);
}

/**
 * Counts what the editor shows rather than the Markdown behind it, so
 * `**bold**` is 1 word and 4 characters. Characters exclude whitespace.
 */
export function countText(doc: ProseMirrorNode): { words: number; characters: number } {
  // Spaces between blocks and around leaves (images, hard breaks) keep words apart.
  const text = doc.textBetween(0, doc.content.size, ' ', ' ');
  return {
    words: text.split(/\s+/).filter(Boolean).length,
    characters: [...text.replace(/\s+/g, '')].length,
  };
}

@Component({
  selector: 'app-note-editor',
  imports: [SlashMenu, LinkMenu, CodeLanguagePicker],
  templateUrl: './note-editor.html',
})
export class NoteEditor {
  private readonly notesState = inject(NotesState);
  private readonly toast = inject(ToastState);
  private readonly editorFocus = inject(EditorFocusState);
  private readonly slashMenuState = inject(SlashMenuState);
  private readonly destroyRef = inject(DestroyRef);
  private readonly vaultState = inject(VaultState);
  private readonly attachments = inject(AttachmentsState);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly dialogState = inject(DialogState);
  private readonly editContext = inject(EditContextState);
  private readonly noteProperties = inject(NotePropertiesState);
  private readonly links = inject(NoteLinksState);
  private readonly linkMenuState = inject(LinkMenuState);
  private readonly tabsState = inject(TabsState);
  private readonly headingFolds = inject(HeadingFoldState);
  private readonly outline = inject(OutlineState);
  private readonly spellcheck = inject(SpellcheckState);

  readonly noteId = input.required<string>();
  /** The tab showing the note, which keys its saved scroll position and selection. */
  readonly tabId = input('');
  /** The element that scrolls the editor. */
  readonly scroller = input<HTMLElement>();

  private readonly mount = viewChild.required<ElementRef<HTMLElement>>('mount');
  private readonly slashMenuCmp = viewChild.required<SlashMenu>('slashMenu');
  private readonly linkMenuCmp = viewChild.required<LinkMenu>('linkMenu');

  private editorView: EditorView | undefined;
  private lastAppliedNoteId: string | undefined;
  /** `viewStates` key of what the editor shows. */
  private appliedKey: string | undefined;
  /** The Markdown this editor last saved or loaded; anything else in `NotesState` came from another pane. */
  private lastMarkdown: string | undefined;

  /** Words and non-whitespace characters of the rendered text, for the content area's toolbar. */
  readonly textStats = signal({ words: 0, characters: 0 });
  /** The find bar's "n of m". */
  readonly findStatus = signal({ current: 0, total: 0 });

  /** The ProseMirror view, once rendered. */
  get view(): EditorView | undefined {
    return this.editorView;
  }

  /** The code block whose language picker is open, and the label it drops down from. */
  protected readonly languagePicker = signal<{ view: EditorView; pos: number; anchor: HTMLElement; current: string } | null>(null);

  protected readonly entryStatus = computed(() => this.notesState.entry(this.noteId())?.status);

  constructor() {
    afterNextRender(() => {
      const id = this.noteId();

      const state = EditorState.create({
        schema,
        doc: parseMarkdown(''),
        plugins: [
          history(),
          buildMarkdownInputRules(),
          // Before syntax reveal, which takes typed backticks as raw Markdown.
          codeFenceInput,
          // Must precede buildEditorKeymap(): ProseMirror runs handleKeyDown
          // handlers in plugin order and stops at the first one that returns
          // true, so this needs first refusal on Enter/Tab/Arrows/Escape
          // while the slash menu is open — otherwise the editor's own Enter
          // keymap splits the block before the menu can confirm a selection.
          createSlashMenuPlugin(this.slashMenuState, () => this.slashMenuCmp().panelElement()),
          // Before the keymap too, for the `[[` menu.
          wikilinkPlugin(this.wikilinkContext(), this.linkMenuState, () => this.linkMenuCmp().panelElement()),
          buildEditorKeymap(),
          gapCursor(),
          headingFoldPlugin(),
          calloutPlugin(),
          footnotePlugin(),
          tocPlugin(),
          findPlugin(),
          spellcheckPlugin(() => this.spellcheck.enabled()),
          dropCursor({ color: 'var(--primary)', width: 2 }),
          trailingParagraphPlugin(),
          taskMarkerPlugin(),
          listMarkerPlugin(),
          syntaxRevealPlugin(
            (href) => void this.attachments.openLinked(this.noteId(), href),
            (target) => void this.openLink(target),
          ),
          mathPlugin(),
          // Last, so images and code blocks get their own menus first.
          new Plugin({
            // On Android a long press selects text, with the system's own Cut / Copy / Paste.
            props: {
              handleDOMEvents: {
                contextmenu: (view, event) => {
                  if (isMobile) return false;
                  // Now, or the content area's menu opens while the spelling is looked up.
                  event.preventDefault();
                  event.stopPropagation();
                  void this.openTextMenu(event, view);
                  return true;
                },
              },
            },
          }),
          imagePlugin(this.imageContext()),
          codeBlockPlugin({
            pickLanguage: (view, pos, anchor) => {
              if (this.languagePicker()?.anchor === anchor) return this.languagePicker.set(null);
              this.languagePicker.set({ view, pos, anchor, current: view.state.doc.nodeAt(pos)?.attrs['params'] ?? '' });
            },
            contextMenu: (event, view, pos) => this.openCodeBlockMenu(event, view, pos),
          }),
          ...tablePlugins(),
        ],
      });

      const view = new EditorView(this.mount().nativeElement, {
        state,
        nodeViews: {
          task_item: (node, nodeView, getPos) => new TaskItemView(node, nodeView, getPos),
          image: (node, nodeView, getPos) => new ImageView(node, nodeView, getPos),
          code_block: (node, nodeView, getPos) => new CodeBlockView(node, nodeView, getPos),
          table: (node, nodeView) =>
            new TableView(node, nodeView, (event, part) => this.contextMenuState.open(event, tableMenu(nodeView, part))),
        },
        // Only affects plain-text pastes; HTML clipboard content still goes
        // through the default DOM parser.
        clipboardTextParser: (text) => Slice.maxOpen(parseMarkdown(text).content),
        // The Edit menu acts on whichever editor last had focus.
        handleDOMEvents: {
          focus: (view) => {
            this.editContext.focusEditor(view);
            this.outline.show(view);
            // With the note open in two panes, the panel edits the one last used.
            this.noteProperties.attach(this.noteId(), view);
          },
          [ADD_PROPERTY_EVENT]: (_view, event) =>
            void this.noteProperties.requestAdd(this.noteId(), (event as CustomEvent).detail === 'tag' ? 'tag' : 'property'),
        },
        dispatchTransaction: (tr) => {
          const before = view.state.doc.attrs;
          const foldsBefore = headingFoldKey.getState(view.state);
          const newState = view.state.apply(tr);
          view.updateState(newState);
          this.editContext.transacted(view);

          const status = findStatus(newState);
          if (status.current !== this.findStatus().current || status.total !== this.findStatus().total) this.findStatus.set(status);

          const { tags, properties } = newState.doc.attrs;
          if (tags !== before['tags'] || properties !== before['properties']) {
            this.noteProperties.applied(this.noteId(), tags, properties);
          }
          if (tr.docChanged) {
            this.outline.changed(view);
            const markdown = serializeMarkdown(newState.doc);
            this.lastMarkdown = markdown;
            // Counted from the saved Markdown, so revealed syntax doesn't count.
            // ponytail: reparses the note per edit; count the doc minus revealed syntax if long notes lag.
            const saved = parseMarkdown(markdown);
            this.textStats.set(countText(saved));
            if (tr.getMeta(OTHER_PANE)) return;
            this.notesState.updateContent(this.noteId(), markdown);
            this.links.setLinks(this.noteId(), wikilinkTargets(saved));
          }
          // Other panes showing the note fold the same headings.
          const foldsChanged = headingFoldKey.getState(newState) !== foldsBefore;
          if ((tr.docChanged || foldsChanged) && this.lastAppliedNoteId === this.noteId() && this.lastMarkdown !== undefined) {
            this.headingFolds.set(this.noteId(), { headings: foldedHeadings(newState), markdown: this.lastMarkdown });
          }
        },
      });

      this.editorView = view;
      this.applyIfReady(id);
    });

    effect(() => {
      const id = this.noteId();
      this.tabId(); // another tab showing the same note has its own view state
      this.notesState.ensureLoaded(id);
      this.notesState.entry(id); // signal read so this effect reruns once loading completes
      this.applyIfReady(id);
    });

    // Tags or properties changed other than through this editor (a tag
    // renamed vault-wide, say): show them, without making that an undo step.
    effect(() => {
      const note = this.notesState.getNote(this.noteId());
      const view = this.editorView;
      if (!note || !view || this.lastAppliedNoteId !== note.id) return;
      untracked(() => {
        const { tags, properties } = view.state.doc.attrs;
        let tr = view.state.tr;
        if (JSON.stringify(tags) !== JSON.stringify(note.tags)) tr = tr.setDocAttribute('tags', note.tags);
        if (!sameProperties(properties, note.properties)) tr = tr.setDocAttribute('properties', note.properties);
        if (tr.docChanged) view.dispatch(tr.setMeta('addToHistory', false));
      });
    });

    // Spellcheck switched on or off.
    effect(() => {
      this.spellcheck.enabled();
      untracked(() => this.editorView?.dispatch(this.editorView.state.tr.setMeta(spellcheckKey, true)));
    });

    // The vault changed, so a link may lead somewhere (or nowhere) now.
    effect(() => {
      this.links.index();
      untracked(() => this.editorView?.dispatch(this.editorView.state.tr.setMeta(wikilinkKey, true)));
    });

    // The same note, edited in another pane: take its text, keeping this
    // pane's history and selection by replacing only what differs.
    effect(() => {
      const note = this.notesState.getNote(this.noteId());
      const view = this.editorView;
      if (!note || !view || this.lastAppliedNoteId !== note.id || note.content === this.lastMarkdown) return;
      untracked(() => {
        this.lastMarkdown = note.content;
        const next = parseMarkdown(note.content);
        const doc = view.state.doc;
        const start = doc.content.findDiffStart(next.content);
        if (start === null) return;
        let { a: endA, b: endB } = doc.content.findDiffEnd(next.content)!;
        const overlap = start - Math.min(endA, endB);
        if (overlap > 0) {
          endA += overlap;
          endB += overlap;
        }
        view.dispatch(view.state.tr.replace(start, endA, next.slice(start, endB)).setMeta('addToHistory', false).setMeta(OTHER_PANE, true));
        const folds = this.headingFolds.folds().get(note.id);
        if (folds) this.applyFolds(view, folds);
      });
    });

    // Headings folded or unfolded in another pane showing the note.
    effect(() => {
      const folds = this.headingFolds.folds().get(this.noteId());
      const view = this.editorView;
      if (folds && view && this.lastAppliedNoteId === this.noteId()) untracked(() => this.applyFolds(view, folds));
    });

    // A save copied an attachment over to this note's profile; follow it.
    effect(() => {
      const relinked = this.notesState.relinked();
      const view = this.editorView;
      if (relinked && view && relinked.noteId === this.noteId()) untracked(() => relinkImages(view, relinked.sources));
    });

    this.destroyRef.onDestroy(() => {
      this.saveViewState();
      if (this.editorView) this.editContext.forgetEditor(this.editorView);
      if (this.editorView) this.noteProperties.detach(this.editorView);
      if (this.editorView) this.outline.forget(this.editorView);
      this.editorView?.destroy();
    });
  }

  /**
   * Stores images in the open note's vault and loads them back through the
   * `mantle://` protocol (`attachments.rs`), which decrypts sealed ones.
   */
  private imageContext(): ImageContext {
    const args = () => ({ noteRelPath: this.noteId() });
    const save = async (file: File) => {
      // A data URL is the cheapest way to get base64 out of a File.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      // A video's type (`video/quicktime`) doesn't name its extension; its file name does.
      const ext = file.type.startsWith('image/')
        ? file.type.slice('image/'.length).replace('+xml', '')
        : (file.name.split('.').pop()?.toLowerCase() ?? '');
      return invoke<string>('save_attachment', { ...args(), data: dataUrl.slice(dataUrl.indexOf(',') + 1), ext });
    };
    // The plugin only logs a failure; the user needs to see it too.
    const reported = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A) =>
      fn(...a).catch((err) => {
        void this.dialogState.alert(formatError(err), { title: "Couldn't Add File", tone: 'error' });
        throw err;
      });
    return {
      save: reported(save),
      pick: reported(async () => {
        // Android's file dialog hands back a `content://` URI, not a path the backend can read; the WebView's own picker gives the bytes.
        if (isMobile) {
          const file = await chooseFile([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, 'pdf'].map((ext) => `.${ext}`).join(','));
          return file && save(file);
        }
        return invoke<string | null>('import_attachment', args());
}),
      url: (src) => attachmentUrl(args().noteRelPath, src),
      open: (src) => void this.attachments.openLinked(this.noteId(), src),
      contextMenu: (event, view, pos, node) => void this.openImageMenu(event, view, pos, node),
    };
  }

  private wikilinkContext(): WikilinkContext {
    return {
      status: (target) => {
        return this.links.index().resolve(target, this.noteId()) || isFileLink(target) ? 'ok' : 'missing';
      },
      suggest: (query) => {
        const index = this.links.index();
        const self = this.noteId();
        const scope = index.scopeOf(self);
        const q = query.trim().toLowerCase();
        const matches = (relPath: string, name: string) =>
          q.includes('/') ? linkPath(relPath).toLowerCase().includes(q) : name.toLowerCase().includes(q);
        const rank = (name: string) => (name.toLowerCase().startsWith(q) ? 0 : 1);
        return index.notes
          .filter((note) => note.relPath !== self && linkScope(note) === scope && matches(note.relPath, note.name))
          .sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length || a.name.localeCompare(b.name))
          .slice(0, 20)
          .map<LinkSuggestion>((note) => ({
            relPath: note.relPath,
            name: note.name,
            dir: dirOf(note.relPath),
            link: index.linkText(note),
          }));
      },
    };
  }

  /** Opens the note a Ctrl/Cmd-clicked `[[link]]` leads to. */
  private async openLink(raw: string): Promise<void> {
    const { target } = splitLink(raw);
    const note = this.links.index().resolve(target, this.noteId());
    if (note) return this.tabsState.openNote({ id: note.relPath, title: note.name });
    if (isFileLink(target)) return this.attachments.openLinked(this.noteId(), target);
    await this.dialogState.alert(`No note is called "${target}".`, { title: "Couldn't Open Link" });
  }

  protected onLanguagePicked(id: string): void {
    const picker = this.languagePicker();
    this.languagePicker.set(null);
    if (!picker) return;
    setCodeBlockLanguage(picker.view, picker.pos, id);
    picker.view.focus();
  }

  private openCodeBlockMenu(event: MouseEvent, view: EditorView, pos: number): void {
    const node = view.state.doc.nodeAt(pos);
    if (!node) return;
    const current = languageId(node.attrs['params']) ?? '';
    this.contextMenuState.open(event, [
      {
        kind: 'submenu',
        label: 'Language',
        icon: 'code',
        items: [{ id: '', name: 'Plain text' }, ...CODE_LANGUAGES].map((lang) => ({
          kind: 'item' as const,
          label: lang.name,
          checked: lang.id === current,
          action: () => setCodeBlockLanguage(view, pos, lang.id),
        })),
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Copy Code', icon: 'copy', action: () => this.toast.copy(codeBody(node).text) },
      { kind: 'item', label: 'Turn into Paragraph', icon: 'paragraph', action: () => codeBlockToParagraph(view, pos) },
    ]);
  }

  /** Right-click on text: the clipboard, formatting, block types and inserts. */
  private async openTextMenu(event: MouseEvent, view: EditorView): Promise<void> {
    const spelling = this.spellcheck.enabled() ? await spellingItems(view, event, this.noteId().endsWith('.enc')) : [];
    const hasSelection = !view.state.selection.empty;
    const inTable = isInTable(view.state);
    const run = (command: 'cut' | 'copy' | 'paste' | 'selectAll') => () => this.editContext.run(command);
    const turn = (kind: BlockKind) => () => turnInto(view, kind);
    const format = (label: string, mark: string, delimiter: string, shortcut?: string): ContextMenuAction => ({
      kind: 'item',
      label,
      shortcut,
      action: () => formatSelection(view, mark, delimiter),
    });
    this.editContext.focusEditor(view);
    this.contextMenuState.open(event, [
      ...spelling,
      { kind: 'item', label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', disabled: !hasSelection, action: run('cut') },
      { kind: 'item', label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', disabled: !hasSelection, action: run('copy') },
      { kind: 'item', label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', action: run('paste') },
      {
        kind: 'item',
        label: 'Paste as Plain Text',
        shortcut: 'Ctrl+Shift+V',
        action: () => pastePlainText(view),
      },
      { kind: 'item', label: 'Select All', shortcut: 'Ctrl+A', action: run('selectAll') },
      { kind: 'separator' },
      {
        kind: 'submenu',
        label: 'Format',
        items: [
          format('Bold', 'strong', '**', 'Ctrl+B'),
          format('Italic', 'em', '*', 'Ctrl+I'),
          format('Strikethrough', 'strike', '~~', 'Ctrl+Shift+X'),
          format('Highlight', 'highlight', '==', 'Ctrl+Shift+H'),
          format('Code', 'code', '`', 'Ctrl+`'),
          { kind: 'separator' },
          { kind: 'item', label: 'Link…', action: () => void this.promptLink(view) },
        ],
      },
      // A cell holds one line, so it has no block types to turn into.
      inTable
        ? { kind: 'submenu', label: 'Table', items: tableMenu(view, 'table') }
        : {
            kind: 'submenu',
            label: 'Turn into',
            items: [
              { kind: 'item', label: 'Paragraph', icon: 'paragraph', action: turn('paragraph') },
              { kind: 'item', label: 'Heading 1', action: turn('h1') },
              { kind: 'item', label: 'Heading 2', action: turn('h2') },
              { kind: 'item', label: 'Heading 3', action: turn('h3') },
              { kind: 'separator' },
              { kind: 'item', label: 'Bullet List', action: turn('bullet_list') },
              { kind: 'item', label: 'Numbered List', action: turn('ordered_list') },
              { kind: 'item', label: 'To-do List', action: turn('task_list') },
              { kind: 'separator' },
              { kind: 'item', label: 'Quote', action: turn('blockquote') },
              { kind: 'item', label: 'Code Block', icon: 'code', action: turn('code_block') },
            ],
          },
      {
        kind: 'submenu',
        label: 'Insert',
        items: [
          { kind: 'item', label: 'Image, Video or PDF…', action: () => void pickImage(view) },
          { kind: 'item', label: 'Divider', action: () => insertHorizontalRule(view) },
          { kind: 'item', label: 'Table', disabled: inTable, action: () => insertTable(view) },
        ],
      },
    ]);
  }

  private async promptLink(view: EditorView): Promise<void> {
    const href = await this.dialogState.prompt('The address to link to.', {
      title: 'Add Link',
      confirmLabel: 'Link',
      placeholder: 'https://',
    });
    if (!href?.trim()) return;
    linkSelection(view, href.trim());
    view.focus();
  }

  private async openImageMenu(event: MouseEvent, view: EditorView, pos: number, node: ProseMirrorNode): Promise<void> {
    // Claim the event now: the content area has its own menu, and this one waits on a lookup.
    event.preventDefault();
    event.stopPropagation();
    const { src, size } = node.attrs;
    const noteId = this.noteId();
    const info = await this.attachments.info(noteId, src).catch(() => null);
    // The note may have changed while the menu was open.
    const resize = (to: string | null) => view.state.doc.nodeAt(pos)?.attrs['src'] === src && resizeImage(view, pos, to);
    const presets: [string, string | null][] = [['Small', '200'], ['Medium', '400'], ['Large', '600'], ['Original', null]];
    this.contextMenuState.open(event, [
      {
        kind: 'submenu',
        label: 'Size',
        items: [
          ...presets.map(([label, to]) => ({
            kind: 'item' as const,
            label: to ? `${label} (${to} px)` : label,
            checked: size === to,
            action: () => resize(to),
          })),
          {
            kind: 'item' as const,
            label: 'Custom…',
            checked: !presets.some(([, to]) => to === size),
            action: () => void this.promptImageSize(size, resize),
          },
        ],
      },
      {
        kind: 'item',
        desktopOnly: true,
        label: 'Show in File Explorer',
        icon: 'reveal',
        disabled: !info,
        action: () => info && void this.vaultState.revealInFileExplorer(info.relPath),
      },
      {
        kind: 'item',
        label: 'Copy Path',
        icon: 'copy',
        action: () => this.toast.copy(info?.relPath ?? src),
      },
      {
        kind: 'item',
        desktopOnly: true,
        label: 'Open in Default App',
        icon: 'open-external',
        // A sealed image would have to be decrypted to disk for another app.
        disabled: !info || info.profile !== null,
        action: () => info && void this.attachments.openInDefaultApp(info.relPath),
      },
      { kind: 'item', label: 'Show Markdown', action: () => revealImageSource(view, pos) },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Remove from Note',
        icon: 'delete',
        danger: true,
        action: () => {
          // The note may have changed while the menu was open.
          if (view.state.doc.nodeAt(pos)?.attrs['src'] !== src) return;
          removeImage(view, pos);
          if (info) void this.attachments.offerDeleteAfterRemoval(noteId, info);
        },
      },
    ]);
  }

  /** Asks for an image's size as `300` or `300x200`, an empty answer for its own. */
  private async promptImageSize(size: string | null, resize: (to: string | null) => void): Promise<void> {
    const answer = await this.dialogState.prompt('A width in px, or width × height like 300x200. Leave empty for its own size.', {
      title: 'Image Size',
      placeholder: '300 or 300x200',
      initialValue: size ?? '',
      confirmLabel: 'Resize',
    });
    if (answer === null) return;
    const to = answer.replace(/\s|px/gi, '').replace('×', 'x').toLowerCase();
    if (!to) return resize(null);
    if (/^[1-9]\d*(x[1-9]\d*)?$/.test(to)) return resize(to);
    await this.dialogState.alert(`"${answer}" isn't a size. Use a width like 300, or width × height like 300x200.`, {
      title: "Couldn't Resize",
    });
  }

  private applyIfReady(id: string): void {
    const view = this.editorView;
    if (!view) return;
    const entry = this.notesState.entry(id);
    if (!entry || entry.status !== 'loaded') {
      // Reloaded (e.g. its images were re-pointed by moving it to another
      // profile), so apply the content again once it arrives.
      if (id === this.lastAppliedNoteId) this.lastAppliedNoteId = undefined;
      return;
    }
    const key = `${this.tabId()}\n${id}`;
    if (id === this.lastAppliedNoteId && key === this.appliedKey) return;
    // A reload of what's already shown keeps its place.
    const switching = key !== this.appliedKey;
    if (switching) this.saveViewState();

    const newDoc = parseMarkdown(entry.note.content);
    // Attached first, so the doc attributes this sets are stored for `id`.
    this.noteProperties.attach(id, view);
    const tr = view.state.tr
      .replaceWith(0, view.state.doc.content.size, newDoc)
      .setDocAttribute('tags', entry.note.tags)
      .setDocAttribute('properties', entry.note.properties)
      // Loading the note isn't an edit to undo.
      .setMeta('addToHistory', false);
    if (switching) {
      const saved = viewStates.get(key);
      const size = tr.doc.content.size;
      const clamp = (pos: number) => Math.min(Math.max(pos, 0), size);
      tr.setSelection(
        saved ? TextSelection.between(tr.doc.resolve(clamp(saved.anchor)), tr.doc.resolve(clamp(saved.head))) : Selection.atStart(tr.doc),
      );
    }
    this.lastMarkdown = entry.note.content;
    view.dispatch(tr);
    // The note just switched to is the one to outline.
    if (switching) this.outline.show(view);
    this.lastAppliedNoteId = id;
    this.appliedKey = key;
    const folds = untracked(() => this.headingFolds.folds().get(id));
    if (folds) this.applyFolds(view, folds);
    const scroller = this.scroller();
    if (switching && scroller) scroller.scrollTop = viewStates.get(key)?.scrollTop ?? 0;
    // Focus keeps the scroll offset; the selection was put back where the note was left.
    if (this.editorFocus.consume(id)) view.focus();
  }

  /** Folds the headings `folds` names, if it was counted in the Markdown this editor shows. */
  private applyFolds(view: EditorView, folds: NoteFolds): void {
    if (folds.markdown !== this.lastMarkdown || foldedHeadings(view.state).join() === folds.headings.join()) return;
    view.dispatch(setFoldedHeadings(view.state.tr, folds.headings));
  }

  private saveViewState(): void {
    const view = this.editorView;
    if (!view || !this.appliedKey) return;
    const { anchor, head } = view.state.selection;
    viewStates.set(this.appliedKey, { scrollTop: this.scroller()?.scrollTop ?? 0, anchor, head });
  }
}

/**
 * Fixes for the misspelled word under `event`, for the top of its menu. In an
 * encrypted note an added word lasts only the session: the list is plaintext.
 */
async function spellingItems(view: EditorView, event: MouseEvent, sessionOnly: boolean): Promise<ContextMenuItem[]> {
  const word = wordAt(view, event);
  if (!word) return [];
  const suggestions = await invoke<string[] | null>('spelling_suggestions', { word: word.text }).catch(() => null);
  if (!suggestions) return [];
  const fixes: ContextMenuItem[] = suggestions.slice(0, 5).map((fix) => ({
    kind: 'item',
    label: fix,
    action: () => {
      // Only if the word is still there.
      if (view.state.doc.textBetween(word.from, word.to) === word.text) {
        view.dispatch(view.state.tr.insertText(fix, word.from, word.to));
      }
      view.focus();
    },
  }));
  if (!fixes.length) fixes.push({ kind: 'item', label: 'No suggestions', disabled: true, action: () => {} });
  fixes.push({
    kind: 'item',
    label: 'Add to Dictionary',
    action: () => {
      void invoke('add_to_dictionary', { word: word.text, sessionOnly }).then(() => {
        forgetMisspelling(word.text);
        view.dispatch(view.state.tr.setMeta(spellcheckKey, true).setMeta('addToHistory', false));
      });
      view.focus();
    },
  });
  return [...fixes, { kind: 'separator' }];
}

/** The word under `event`, outside code. */
function wordAt(view: EditorView, event: MouseEvent): { from: number; to: number; text: string } | null {
  const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (pos === undefined) return null;
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code || $pos.marks().some((mark) => mark.type.spec.code)) return null;
  // One character per inline leaf, so string offsets are doc offsets.
  const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, '\u{fffc}');
  for (const match of text.matchAll(/[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*/gu)) {
    if (match.index <= $pos.parentOffset && $pos.parentOffset <= match.index + match[0].length) {
      const from = $pos.start() + match.index;
      return { from, to: from + match[0].length, text: match[0] };
    }
  }
  return null;
}
