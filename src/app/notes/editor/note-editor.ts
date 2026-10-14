import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  untracked,
  viewChild,
} from '@angular/core';
import { EditorState, Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice } from 'prosemirror-model';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands, joinTextblockBackward, toggleMark } from 'prosemirror-commands';
import { splitListItem, sinkListItem, liftListItem } from 'prosemirror-schema-list';
import { undoInputRule } from 'prosemirror-inputrules';
import { gapCursor } from 'prosemirror-gapcursor';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

import { AttachmentsState, attachmentUrl } from '../attachments-state';
import { CredentialsState } from '../credentials-state';
import { NotesState } from '../notes-state';
import { VaultState } from '../vault-state';
import { VaultRootState } from '../vault-root-state';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { DialogState } from '../../shared/dialog/dialog-state';
import { EditorFocusState } from './editor-focus-state';
import { schema } from './prosemirror/schema';
import { parseMarkdown, serializeMarkdown } from './prosemirror/markdown-converter';
import { createSlashMenuPlugin } from './prosemirror/plugins/slash-menu-plugin';
import { buildMarkdownInputRules } from './prosemirror/plugins/markdown-input-rules';
import { trailingParagraphPlugin } from './prosemirror/plugins/trailing-paragraph-plugin';
import { demoteEmptyLeadingBlock } from './prosemirror/commands/demote-empty-leading-block';
import { liftListItemAtStart } from './prosemirror/commands/lift-list-item-at-start';
import { TaskItemView } from './prosemirror/nodeviews/task-item-view';
import { ImageView } from './prosemirror/nodeviews/image-view';
import {
  ImageContext,
  editImageSource,
  imagePlugin,
  relinkImages,
  removeImage,
} from './prosemirror/plugins/image-plugin';

import { SlashMenu } from './slash-menu/slash-menu';
import { SlashMenuState } from './slash-menu/slash-menu-state';

function buildEditorKeymap() {
  const keys: Record<string, Command> = {
    ...baseKeymap,
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
    'Mod-b': (state, dispatch, view) => toggleMark(schema.marks['strong'])(state, dispatch, view),
    'Mod-i': (state, dispatch, view) => toggleMark(schema.marks['em'])(state, dispatch, view),
    'Mod-`': (state, dispatch, view) => toggleMark(schema.marks['code'])(state, dispatch, view),
    Enter: chainCommands(
      splitListItem(schema.nodes['list_item']),
      splitListItem(schema.nodes['task_item']),
      baseKeymap['Enter']
    ),
    Tab: chainCommands(
      sinkListItem(schema.nodes['list_item']),
      sinkListItem(schema.nodes['task_item'])
    ),
    'Shift-Tab': chainCommands(
      liftListItem(schema.nodes['list_item']),
      liftListItem(schema.nodes['task_item'])
    ),
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
      demoteEmptyLeadingBlock,
      liftListItemAtStart(schema.nodes['list_item']),
      liftListItemAtStart(schema.nodes['task_item']),
      joinTextblockBackward,
      baseKeymap['Backspace']
    ),
  };
  return keymap(keys);
}

@Component({
  selector: 'app-note-editor',
  imports: [SlashMenu],
  templateUrl: './note-editor.html',
})
export class NoteEditor {
  private readonly notesState = inject(NotesState);
  private readonly editorFocus = inject(EditorFocusState);
  private readonly slashMenuState = inject(SlashMenuState);
  private readonly destroyRef = inject(DestroyRef);
  private readonly vaultRoot = inject(VaultRootState).path;
  private readonly vaultState = inject(VaultState);
  private readonly attachments = inject(AttachmentsState);
  private readonly credentialsState = inject(CredentialsState);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly dialogState = inject(DialogState);

  readonly noteId = input.required<string>();

  private readonly mount = viewChild.required<ElementRef<HTMLElement>>('mount');
  private readonly slashMenuCmp = viewChild.required<SlashMenu>('slashMenu');

  private editorView: EditorView | undefined;
  private lastAppliedNoteId: string | undefined;

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
          // Must precede buildEditorKeymap(): ProseMirror runs handleKeyDown
          // handlers in plugin order and stops at the first one that returns
          // true, so this needs first refusal on Enter/Tab/Arrows/Escape
          // while the slash menu is open — otherwise the editor's own Enter
          // keymap splits the block before the menu can confirm a selection.
          createSlashMenuPlugin(this.slashMenuState, () => this.slashMenuCmp().panelElement()),
          buildEditorKeymap(),
          gapCursor(),
          trailingParagraphPlugin(),
          imagePlugin(this.imageContext()),
        ],
      });

      const view = new EditorView(this.mount().nativeElement, {
        state,
        nodeViews: {
          task_item: (node, nodeView, getPos) => new TaskItemView(node, nodeView, getPos),
          image: (node, nodeView, getPos) => new ImageView(node, nodeView, getPos),
        },
        // Only affects plain-text pastes; HTML clipboard content still goes
        // through the default DOM parser.
        clipboardTextParser: (text) => Slice.maxOpen(parseMarkdown(text).content),
        dispatchTransaction: (tr) => {
          const newState = view.state.apply(tr);
          view.updateState(newState);

          if (tr.docChanged) {
            const markdown = serializeMarkdown(newState.doc);
            this.notesState.updateContent(this.noteId(), markdown);
          }
        },
      });

      this.editorView = view;
      this.applyIfReady(id);
    });

    effect(() => {
      const id = this.noteId();
      this.notesState.ensureLoaded(id);
      this.notesState.entry(id); // signal read so this effect reruns once loading completes
      this.applyIfReady(id);
    });

    // A save copied an attachment over to this note's profile; follow it.
    effect(() => {
      const relinked = this.notesState.relinked();
      const view = this.editorView;
      if (relinked && view && relinked.noteId === this.noteId()) untracked(() => relinkImages(view, relinked.sources));
    });

    this.destroyRef.onDestroy(() => this.editorView?.destroy());
  }

  /**
   * Stores images in the open note's vault and loads them back through the
   * `mantle://` protocol (`attachments.rs`), which decrypts sealed ones.
   */
  private imageContext(): ImageContext {
    const args = () => ({ vaultRoot: this.vaultRoot() ?? '', noteRelPath: this.noteId() });
    return {
      save: async (file) => {
        // A data URL is the cheapest way to get base64 out of a File.
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const ext = file.type.slice('image/'.length).replace('+xml', '');
        return invoke<string>('save_attachment', { ...args(), data: dataUrl.slice(dataUrl.indexOf(',') + 1), ext });
      },
      pick: async () => {
        const sourcePath = await open({
          multiple: false,
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'] }],
        });
        return sourcePath ? invoke<string>('import_attachment', { ...args(), sourcePath }) : null;
      },
      url: (src) => attachmentUrl(args().vaultRoot, args().noteRelPath, src),
      describe: async (src) => {
        const info = await this.attachments.info(this.noteId(), src);
        return info && { ...info, profile: info.profile && this.credentialsState.displayNameOf(info.profile) };
      },
      contextMenu: (event, view, pos, node) => void this.openImageMenu(event, view, pos, node.attrs['src']),
      editSource: (markdown) =>
        this.dialogState.prompt("Edit the image's Markdown. Clear it to remove the image.", {
          title: 'Edit Image Source',
          confirmLabel: 'Save',
          initialValue: markdown,
        }),
    };
  }

  private async openImageMenu(event: MouseEvent, view: EditorView, pos: number, src: string): Promise<void> {
    // Claim the event now: the content area has its own menu, and this one waits on a lookup.
    event.preventDefault();
    event.stopPropagation();
    const noteId = this.noteId();
    const info = await this.attachments.info(noteId, src).catch(() => null);
    this.contextMenuState.open(event, [
      {
        kind: 'item',
        label: 'Show in File Explorer',
        icon: 'reveal',
        disabled: !info,
        action: () => info && void this.vaultState.revealInFileExplorer(info.relPath),
      },
      {
        kind: 'item',
        label: 'Copy Path',
        icon: 'copy',
        action: () => void navigator.clipboard.writeText(info?.relPath ?? src),
      },
      {
        kind: 'item',
        label: 'Open in Default App',
        icon: 'open-external',
        // A sealed image would have to be decrypted to disk for another app.
        disabled: !info || info.profile !== null,
        action: () => info && void this.attachments.openInDefaultApp(info.relPath),
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Edit Source…', icon: 'rename', action: () => void editImageSource(view, pos) },
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
    if (id === this.lastAppliedNoteId) return;

    const newDoc = parseMarkdown(entry.note.content);
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc);
    view.dispatch(tr);
    this.lastAppliedNoteId = id;
    if (this.editorFocus.consume(id)) view.focus();
  }
}
