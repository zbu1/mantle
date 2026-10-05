import { Plugin, PluginKey } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { logError, formatError } from '../../../../core/logger';
import { schema } from '../schema';

/** What the editor needs from the app to store and show a note's images. */
export interface ImageContext {
  /** Stores a pasted or dropped image, resolving its vault-relative path. */
  save(file: File): Promise<string>;
  /** Lets the user pick an image file and stores it; null if they cancel. */
  pick(): Promise<string | null>;
  /** The URL an image `src` from the current note loads from. */
  url(src: string): string;
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
