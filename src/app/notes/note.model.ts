export interface NoteTag {
  name: string;
  color: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  favorite: boolean;
  folder: string;
  tags: NoteTag[];
  updatedAt: string;
}
