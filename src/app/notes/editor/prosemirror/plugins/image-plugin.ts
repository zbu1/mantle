import { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { logError, formatError } from '../../../../core/logger';
import { parseMarkdown, serializeMarkdown } from '../markdown-converter';
import { schema } from '../schema';

/** Where an image's `src` leads, for the bar shown under a selected image. */
export interface ImageDescription {
  /** The vault-relative path it resolved to. */
  relPath: string;
  /** In Mantle's `attachments/` folder, rather than one of the user's own files. */
  managed: boolean;
  /** Display name of the profile it's encrypted under, or null if plaintext. */
  profile: string | null;
}

/** What the editor needs from the app to store and show a note's images. */
export interface ImageContext {
  /** Stores a pasted or dropped image, resolving its vault-relative path. */
  save(file: File): Promise<string>;
  /** Lets the user pick an image file and stores it; null if they cancel. */
  pick(): Promise<string | null>;
  /** The URL an image `src` from the current note loads from. */
  url(src: string): string;
  /** Where an image `src` from the current note leads; null for a remote URL or a missing file. */
  describe(src: string): Promise<ImageDescription | null>;
  /** Opens the context menu for the image `node` at `pos`. */
  contextMenu(event: MouseEvent, view: EditorView, pos: number, node: PMNode): void;
  /** Lets the user edit an image's Markdown source; resolves the new text, or null if cancelled. */
  editSource(markdown: string): Promise<string | null>;
}

export const imagePluginKey = new PluginKey<ImageContext>('images');

export function imageContext(view: EditorView): ImageContext | undefined {
  return imagePluginKey.getState(view.state);
}

export function insertImage(view: EditorView, src: string, pos?: number): void {
  const node = schema.nodes['image'].create({ src });
  const { tr } = view.state;
  view.dispatch(pos === undefined ? tr.replaceSelectionWith(node) : tr.insert(Math.min(pos, tr.doc.content.size), node));
}

/** Removes the image node at `pos` from the note. */
export function removeImage(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos);
  if (node?.type === schema.nodes['image']) view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
}

/**
 * Lets the user rewrite the image at `pos` as Markdown — `![alt](src)` or
 * `![[src|size]]` — and puts back whatever that parses to. Clearing it
 * removes the image.
 */
export async function editImageSource(view: EditorView, pos: number | undefined): Promise<void> {
  const node = pos === undefined ? null : view.state.doc.nodeAt(pos);
  const context = imageContext(view);
  if (pos === undefined || node?.type !== schema.nodes['image'] || !context) return;

  const markdown = serializeMarkdown(schema.node('doc', null, [schema.node('paragraph', null, [node])])).trim();
  const edited = await context.editSource(markdown);
  // The note may have changed while the dialog was open.
  if (edited === null || edited.trim() === markdown || view.state.doc.nodeAt(pos) !== node) return;

  const inline = parseMarkdown(edited.trim()).firstChild;
  const content = inline?.isTextblock ? inline.content : [];
  view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, content));
  view.focus();
}

/**
 * Points images at the sources a save re-pointed them to (see
 * `NotesState.relinked`). Kept out of undo history: undoing it would only
 * bring back a link the next save re-points again.
 */
export function relinkImages(view: EditorView, sources: Readonly<Record<string, string>>): void {
  const { tr } = view.state;
  view.state.doc.descendants((node, pos) => {
    const to = node.type === schema.nodes['image'] ? sources[node.attrs['src']] : undefined;
    if (to) tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: to });
  });
  if (tr.docChanged) view.dispatch(tr.setMeta('addToHistory', false));
}

/** Stores and inserts the image files among `files`, if any; false if there are none to handle. */
function insertFiles(view: EditorView, files: FileList | undefined, pos?: number): boolean {
  const images = [...(files ?? [])].filter((file) => file.type.startsWith('image/'));
  const context = imageContext(view);
  if (images.length === 0 || !context) return false;
  void (async () => {
    for (const file of images) {
      try {
        insertImage(view, await context.save(file), pos);
      } catch (err) {
        logError(`Failed to add image "${file.name}": ${formatError(err)}`);
      }
    }
  })();
  return true;
}

/** Image paste and drop; the editor's `/image` command goes through `imageContext(view).pick()`. */
export function imagePlugin(context: ImageContext): Plugin<ImageContext> {
  return new Plugin({
    key: imagePluginKey,
    state: { init: () => context, apply: (_tr, value) => value },
    props: {
      handlePaste: (view, event) => insertFiles(view, event.clipboardData?.files),
      handleDrop: (view, event) =>
        insertFiles(view, event.dataTransfer?.files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos),
    },
  });
}

export async function pickImage(view: EditorView): Promise<void> {
  try {
    const src = await imageContext(view)?.pick();
    if (src) insertImage(view, src);
  } catch (err) {
    logError(`Failed to add image: ${formatError(err)}`);
  }
}
