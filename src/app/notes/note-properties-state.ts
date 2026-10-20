import { Injectable, inject, signal } from '@angular/core';
import { redo, undo } from 'prosemirror-history';
import { EditorView } from 'prosemirror-view';
import { NotesState } from './notes-state';
import { NoteProperty, PropertyType, PropertyValue, propertyType } from './properties';
import { TagsState } from './tags-state';
import { VaultMetaState } from './vault-meta-state';

/** A request for a note's properties panel to start adding a property or a tag. */
export interface AddPropertyRequest {
  noteId: string;
  kind: 'property' | 'tag';
}

/**
 * Editing a note's tags and properties from its properties panel.
 *
 * An edit goes through the note's open editor as a doc attribute change
 * (`tr.setDocAttribute`), so it lands in the editor's own undo history and
 * Ctrl+Z in the note undoes it in order with text edits. The editor reports
 * every attribute change back through `applied`, which is what actually
 * stores it, an undo included. With no editor open the edit is stored
 * directly, without undo.
 */
@Injectable({ providedIn: 'root' })
export class NotePropertiesState {
  private readonly notesState = inject(NotesState);
  private readonly tagsState = inject(TagsState);
  private readonly vaultMeta = inject(VaultMetaState);
  private readonly editors = new Map<string, EditorView>();

  /** Set by the note menus and the slash menu; the note's panel consumes it. */
  readonly addRequest = signal<AddPropertyRequest | null>(null);

  /** Whether "Linked from" is expanded, in every note's panel. */
  readonly backlinksOpen = signal(false);
  /** Set by "Show Backlinks"; the note's panel consumes it. */
  readonly backlinksRequest = signal<{ noteId: string } | null>(null);

  /** `view` now shows `noteId`. */
  attach(noteId: string, view: EditorView): void {
    this.detach(view);
    this.editors.set(noteId, view);
  }

  /** `view` no longer shows any note. */
  detach(view: EditorView): void {
    for (const [noteId, attached] of this.editors) if (attached === view) this.editors.delete(noteId);
  }

  editorFor(noteId: string): EditorView | undefined {
    return this.editors.get(noteId);
  }

  /** The note an editor shows, for the slash menu, which only knows its view. */
  noteIdOf(view: EditorView): string | undefined {
    return [...this.editors].find(([, attached]) => attached === view)?.[0];
  }

  setTags(noteId: string, tags: string[]): void {
    this.edit(noteId, 'tags', tags, () => this.tagsState.setNoteTags(noteId, tags));
  }

  setProperties(noteId: string, properties: NoteProperty[]): void {
    this.edit(noteId, 'properties', properties, () => this.notesState.updateProperties(noteId, properties));
  }

  /** The editor's doc attributes changed: an edit from the panel, or its undo. */
  applied(noteId: string, tags: string[], properties: NoteProperty[] | null): void {
    const current = this.notesState.getNote(noteId)?.tags;
    if (current && JSON.stringify(current) !== JSON.stringify(tags)) this.tagsState.setNoteTags(noteId, tags);
    if (properties) this.notesState.updateProperties(noteId, properties);
  }

  /** Undo in the note's editor, for Ctrl+Z on a part of the panel with no undo of its own. */
  undo(noteId: string): void {
    const view = this.editors.get(noteId);
    if (view) undo(view.state, view.dispatch);
  }

  redo(noteId: string): void {
    const view = this.editors.get(noteId);
    if (view) redo(view.state, view.dispatch);
  }

  showBacklinks(noteId: string): void {
    this.backlinksOpen.set(true);
    this.backlinksRequest.set({ noteId });
  }

  requestAdd(noteId: string, kind: AddPropertyRequest['kind']): void {
    this.addRequest.set({ noteId, kind });
  }

  /** The type `key`'s value shows as; see `propertyType`. */
  typeOf(key: string, value: PropertyValue): PropertyType | null {
    return propertyType(value, this.vaultMeta.propertyType(key));
  }

  /** The type a new property called `key` starts as. */
  defaultType(key: string): PropertyType {
    return this.vaultMeta.propertyType(key) ?? 'text';
  }

  setVaultType(key: string, type: PropertyType): void {
    this.vaultMeta.setPropertyType(key, type);
  }

  private edit(noteId: string, attr: 'tags' | 'properties', value: unknown, fallback: () => void): void {
    const view = this.editors.get(noteId);
    if (view) view.dispatch(view.state.tr.setDocAttribute(attr, value));
    else fallback();
  }
}
