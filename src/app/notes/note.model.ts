export interface Note {
  id: string;
  title: string;
  content: string;
}

/** Lightweight reference to a note — enough to open/track a tab without its content. */
export interface NoteRef {
  id: string;
  title: string;
}
