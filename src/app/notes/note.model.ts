import { NoteProperty } from './properties';

export interface Note {
  id: string;
  title: string;
  content: string;
  /** The note's tags, stored in its frontmatter; see `tags.ts`. */
  tags: string[];
  /**
   * Its other properties, in order (see `properties.ts`), or null for a
   * Markdown file whose frontmatter can't be read: then it's left alone.
   */
  properties: NoteProperty[] | null;
}

/** Lightweight reference to a note — enough to open/track a tab without its content. */
export interface NoteRef {
  id: string;
  title: string;
}
