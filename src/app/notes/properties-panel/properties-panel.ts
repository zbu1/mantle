import { Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import {
  LucideBinary,
  LucideBraces,
  LucideCalendar,
  LucideChevronRight,
  LucideCalendarClock,
  LucideList,
  LucidePlus,
  LucideSquareCheck,
  LucideChevronDown,
  LucideTags,
  LucideText,
  LucideTriangleAlert,
  LucideX,
} from '@lucide/angular';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { DialogState } from '../../shared/dialog/dialog-state';
import { EditContextState } from '../../shared/edit-context-state';
import { NoteLinksState } from '../note-links-state';
import { NotePropertiesState } from '../note-properties-state';
import { TabsState } from '../tabs-state';
import { dirOf } from '../vault-tree.model';
import { NotesState } from '../notes-state';
import { NoteProperty, PROPERTY_TYPES, PropertyType, PropertyValue, convertValue, displayValue } from '../properties';
import { TagBar } from '../tag-bar/tag-bar';

interface PropertyRow extends NoteProperty {
  type: PropertyType | null;
}

/** Whether `el` is a field with its own text undo, which Ctrl+Z should be left to. */
function isTextField(el: EventTarget | null): boolean {
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== 'checkbox');
}

/**
 * A note's properties, above its body: tags first, then the rest in the
 * note's order, each edited as its type. Only shown when the note has any,
 * or one is being added (from the note menus or the slash menu).
 */
@Component({
  selector: 'app-properties-panel',
  imports: [
    TagBar,
    LucideBinary,
    LucideBraces,
    LucideCalendar,
    LucideChevronRight,
    LucideCalendarClock,
    LucideList,
    LucidePlus,
    LucideSquareCheck,
    LucideChevronDown,
    LucideTags,
    LucideText,
    LucideTriangleAlert,
    LucideX,
  ],
  templateUrl: './properties-panel.html',
  host: { class: 'block' },
})
export class PropertiesPanel {
  private readonly notesState = inject(NotesState);
  private readonly noteProperties = inject(NotePropertiesState);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly dialogState = inject(DialogState);
  private readonly editContext = inject(EditContextState);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly links = inject(NoteLinksState);
  private readonly tabsState = inject(TabsState);

  readonly noteId = input.required<string>();

  private readonly tagBar = viewChild(TagBar);
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  protected readonly note = computed(() => this.notesState.getNote(this.noteId()));
  protected readonly tags = computed(() => this.note()?.tags ?? []);
  /** Null when the note is a Markdown file whose frontmatter can't be read. */
  protected readonly properties = computed(() => this.note()?.properties ?? null);
  protected readonly rows = computed<PropertyRow[]>(() =>
    (this.properties() ?? []).map((p) => ({ ...p, type: this.noteProperties.typeOf(p.key, p.value) })),
  );

  /** A tag is being added to a note with none, so the row shows before it has a chip. */
  protected readonly addingTag = signal(false);
  protected readonly addingProperty = signal(false);
  protected readonly nameError = signal<string | null>(null);

  protected readonly showTags = computed(() => this.tags().length > 0 || this.addingTag());

  /** The notes that link here, each with its folder. */
  protected readonly backlinks = computed(() =>
    this.links.index().backlinks(this.noteId()).map((note) => ({ note, dir: dirOf(note.relPath) })),
  );
  protected readonly backlinksOpen = this.noteProperties.backlinksOpen;
  /** Asked for by "Show Backlinks", so the section shows even with none. */
  protected readonly backlinksWanted = signal(false);
  protected readonly showBacklinks = computed(() => this.backlinks().length > 0 || this.backlinksWanted());

  protected readonly visible = computed(
    () =>
      !!this.note() &&
      (this.showTags() || this.rows().length > 0 || this.addingProperty() || this.properties() === null || this.showBacklinks()),
  );

  constructor() {
    effect(() => {
      const request = this.noteProperties.backlinksRequest();
      if (!request || request.noteId !== this.noteId()) return;
      untracked(() => {
        this.noteProperties.backlinksRequest.set(null);
        this.backlinksWanted.set(true);
        setTimeout(() => this.host.nativeElement.querySelector('[data-backlinks]')?.scrollIntoView({ block: 'nearest' }));
      });
    });

    effect(() => {
      const request = this.noteProperties.addRequest();
      if (!request || request.noteId !== this.noteId()) return;
      untracked(() => {
        this.noteProperties.addRequest.set(null);
        if (request.kind === 'tag') this.startAddingTag();
        else this.startAddingProperty();
      });
    });
  }

  protected openBacklink(relPath: string, name: string): void {
    this.tabsState.openNote({ id: relPath, title: name });
  }

  startAddingProperty(): void {
    if (this.properties() === null) return;
    this.addingProperty.set(true);
    this.nameError.set(null);
    setTimeout(() => this.nameInput()?.nativeElement.focus());
  }

  startAddingTag(): void {
    if (this.properties() === null) return;
    this.addingTag.set(true);
    setTimeout(() => this.tagBar()?.startAdding());
  }

  protected onNameKeydown(event: KeyboardEvent, field: HTMLInputElement): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitName(field.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.addingProperty.set(false);
    }
  }

  protected onNameBlur(field: HTMLInputElement): void {
    if (!this.addingProperty()) return;
    if (field.value.trim()) this.commitName(field.value);
    else this.addingProperty.set(false);
  }

  private commitName(raw: string): void {
    const key = raw.trim();
    if (!key) return void this.addingProperty.set(false);
    if (key.toLowerCase() === 'tags' || key.toLowerCase() === 'tag') {
      this.addingProperty.set(false);
      return this.startAddingTag();
    }
    if (this.rows().some((row) => row.key === key)) {
      this.nameError.set(`This note already has "${key}".`);
      return;
    }
    const type = this.noteProperties.defaultType(key);
    this.addingProperty.set(false);
    this.noteProperties.setVaultType(key, type);
    this.write([...(this.properties() ?? []), { key, value: convertValue(null, type) }]);
    this.focusValue(key);
  }

  protected setValue(key: string, value: PropertyValue): void {
    this.write((this.properties() ?? []).map((p) => (p.key === key ? { ...p, value } : p)));
  }

  protected onText(key: string, field: HTMLInputElement): void {
    this.setValue(key, field.value === '' ? null : field.value);
  }

  protected onNumber(key: string, field: HTMLInputElement): void {
    this.setValue(key, field.value === '' || !Number.isFinite(field.valueAsNumber) ? null : field.valueAsNumber);
  }

  protected onDateTime(key: string, field: HTMLInputElement): void {
    this.setValue(key, field.value || null);
  }

  /** What a `datetime-local` input can show of a stored date-time. */
  protected localDateTime(value: PropertyValue): string {
    return typeof value === 'string' ? value.replace(' ', 'T').slice(0, 16) : '';
  }

  protected listItems(value: PropertyValue): string[] {
    return Array.isArray(value) ? value.map(String) : [];
  }

  protected onListKeydown(event: KeyboardEvent, row: PropertyRow, field: HTMLInputElement): void {
    const items = this.listItems(row.value);
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      this.addListItem(row, field);
    } else if (event.key === 'Backspace' && !field.value && items.length > 0) {
      event.preventDefault();
      this.setValue(row.key, items.slice(0, -1));
    }
  }

  protected addListItem(row: PropertyRow, field: HTMLInputElement): void {
    const item = field.value.trim();
    field.value = '';
    if (item) this.setValue(row.key, [...this.listItems(row.value), item]);
  }

  protected removeListItem(row: PropertyRow, index: number): void {
    this.setValue(row.key, this.listItems(row.value).filter((_, i) => i !== index));
  }

  protected display(value: PropertyValue): string {
    return displayValue(value);
  }

  protected openMenu(event: MouseEvent, row: PropertyRow): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuState.open(event, [
      {
        kind: 'submenu',
        label: 'Type',
        items: PROPERTY_TYPES.map((type) => ({
          kind: 'item' as const,
          label: type.label,
          checked: type.id === row.type,
          action: () => this.changeType(row, type.id),
        })),
      },
      { kind: 'item', label: 'Rename…', icon: 'rename', action: () => void this.rename(row) },
      { kind: 'separator' },
      { kind: 'item', label: 'Remove', icon: 'delete', danger: true, action: () => this.remove(row.key) },
    ]);
  }

  protected openTagsMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuState.open(event, [
      { kind: 'item', label: 'Add Tag', action: () => this.startAddingTag() },
      { kind: 'separator' },
      { kind: 'item', label: 'Remove All Tags', icon: 'delete', danger: true, action: () => this.noteProperties.setTags(this.noteId(), []) },
    ]);
  }

  /** Makes `row`'s name that type in every note, converting this note's value to fit. */
  private changeType(row: PropertyRow, type: PropertyType): void {
    this.noteProperties.setVaultType(row.key, type);
    const value = convertValue(row.value, type);
    if (JSON.stringify(value) !== JSON.stringify(row.value)) this.setValue(row.key, value);
  }

  private async rename(row: PropertyRow): Promise<void> {
    const name = (await this.dialogState.prompt('The new name for this property, in this note.', {
      title: 'Rename Property',
      confirmLabel: 'Rename',
      initialValue: row.key,
    }))?.trim();
    if (!name || name === row.key) return;
    if (name.toLowerCase() === 'tags' || this.rows().some((other) => other.key === name)) {
      await this.dialogState.alert(`This note already has "${name}".`, { title: 'Rename Failed', tone: 'error' });
      return;
    }
    this.write((this.properties() ?? []).map((p) => (p.key === row.key ? { ...p, key: name } : p)));
  }

  private remove(key: string): void {
    this.write((this.properties() ?? []).filter((p) => p.key !== key));
  }

  private write(properties: NoteProperty[]): void {
    this.noteProperties.setProperties(this.noteId(), properties);
  }

  private focusValue(key: string): void {
    setTimeout(() => {
      const row = [...this.host.nativeElement.querySelectorAll<HTMLElement>('[data-property]')].find(
        (el) => el.dataset['property'] === key,
      );
      row?.querySelector<HTMLElement>('input, button')?.focus();
    });
  }

  protected onFocusIn(event: FocusEvent): void {
    // Undo from the Edit menu reaches this note's editor, except in a text
    // field, which has its own.
    const view = this.noteProperties.editorFor(this.noteId());
    if (view && !isTextField(event.target)) this.editContext.focusEditor(view);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || isTextField(event.target)) return;
    const key = event.key.toLowerCase();
    const command = key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' && !event.shiftKey ? 'redo' : null;
    if (!command) return;
    event.preventDefault();
    this.noteProperties[command](this.noteId());
  }
}
