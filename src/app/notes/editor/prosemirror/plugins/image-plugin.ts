import { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { logError, formatError } from '../../../../core/logger';
import { serializeMarkdown } from '../markdown-converter';
import { schema } from '../schema';

/** What the editor needs from the app to store and show a note's images. */
export interface ImageContext {
  /** Stores a pasted or dropped image, resolving its vault-relative path. */
  save(file: File): Promise<string>;
  /** Lets the user pick an image file and stores it; null if they cancel. */
  pick(): Promise<string | null>;
  /** The URL an image `src` from the current note loads from. */
  url(src: string): string;
  /** Opens the file an image `src` from the current note leads to in its own tab. */
  open(src: string): void;
  /** Opens the context menu for the image `node` at `pos`. */
  contextMenu(event: MouseEvent, view: EditorView, pos: number, node: PMNode): void;
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

/** Sets the size (`"300"` or `"300x200"`, null for its own) of the image node at `pos`. */
export function resizeImage(view: EditorView, pos: number, size: string | null): void {
  const node = view.state.doc.nodeAt(pos);
  if (node?.type !== schema.nodes['image'] || node.attrs['size'] === size) return;
  const resized = node.type.create({ ...node.attrs, size }, null, node.marks);
  const tr = view.state.tr.setNodeMarkup(pos, undefined, resized.attrs);
  // A revealed source is what gets saved, so it follows too.
  const $pos = tr.doc.resolve(pos);
  const source = $pos.nodeBefore;
  if (source?.isText && source.marks.some((mark) => mark.type === schema.marks['md_raw'] && mark.attrs['image'])) {
    const markdown = serializeMarkdown(schema.node('doc', null, [schema.node('paragraph', null, [resized])])).trim();
    tr.replaceWith(pos - source.nodeSize, pos, schema.text(markdown, source.marks));
  }
  view.dispatch(tr);
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
    // A revealed source is what gets saved, so it follows too.
    if (node.isText && node.marks.some((mark) => mark.type === schema.marks['md_raw'] && mark.attrs['image'])) {
      const text = Object.entries(sources).reduce((acc, [from, next]) => acc.split(from).join(next), node.text!);
      if (text !== node.text) tr.insertText(text, tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize));
    }
  });
  if (tr.docChanged) view.dispatch(tr.setMeta('addToHistory', false));
}

/** Stores and inserts the image, video and PDF files among `files`, if any; false if there are none to handle. */
function insertFiles(view: EditorView, files: FileList | undefined, pos?: number): boolean {
  const images = [...(files ?? [])].filter((file) => /^(image|video)\/|^application\/pdf$/.test(file.type));
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
