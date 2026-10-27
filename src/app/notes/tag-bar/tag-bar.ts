import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { TagActions } from '../tag-actions';
import { Component, ElementRef, afterRenderEffect, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { LucideHash, LucidePlus, LucideX } from '@lucide/angular';
import { MenuItem } from '../../shared/menu/menu-item';
import { MenuSurface } from '../../shared/menu/menu-surface';
import { NotePropertiesState } from '../note-properties-state';
import { NotesState } from '../notes-state';
import { TagsState } from '../tags-state';
import { isTagChar, normalizeTag, sameTag, TAG_RULES, tagKey } from '../tags';

/** Most suggestions the autocomplete lists at once. */
const MAX_SUGGESTIONS = 6;

interface Suggestion {
  tag: string;
  /** True for the "Create #tag" row, i.e. a tag not yet anywhere in the vault. */
  create: boolean;
  /** How many notes already have the tag. */
  count: number;
}

/**
 * The tag chips in a note's properties panel. Clicking a chip reveals the
 * tag in the sidebar; "+" opens an inline input that autocompletes from the
 * vault's existing tags.
 */
@Component({
  selector: 'app-tag-bar',
  imports: [MenuSurface, MenuItem, LucideHash, LucidePlus, LucideX],
  templateUrl: './tag-bar.html',
  host: { class: 'block' },
})
export class TagBar {
  private readonly notesState = inject(NotesState);
  private readonly tagsState = inject(TagsState);
  private readonly tagActions = inject(TagActions);
  private readonly contextMenuState = inject(ContextMenuState);
  private readonly noteProperties = inject(NotePropertiesState);

  readonly noteId = input.required<string>();
  /** The inline input closed. */
  readonly done = output<void>();

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');

  protected readonly loaded = computed(() => this.notesState.getNote(this.noteId()) !== undefined);
  protected readonly tags = computed(() => this.notesState.getNote(this.noteId())?.tags ?? []);

  protected readonly adding = signal(false);
  protected readonly draft = signal('');
  protected readonly error = signal<string | null>(null);
  /** Highlighted suggestion, or -1 for none (Enter then adds the draft as typed). */
  protected readonly activeIndex = signal(-1);

  protected readonly suggestions = computed<Suggestion[]>(() => {
    const draft = this.draft();
    const key = tagKey(draft);
    const onNote = this.tags();
    const available = this.tagsState
      .groups()
      .filter((group) => !onNote.some((tag) => sameTag(tag, group.name)))
      .filter((group) => group.key.includes(key))
      // Prefix matches first, then the most-used tags.
      .sort((a, b) => Number(b.key.startsWith(key)) - Number(a.key.startsWith(key)) || b.notes.length - a.notes.length)
      .slice(0, MAX_SUGGESTIONS)
      .map((group) => ({ tag: group.name, create: false, count: group.notes.length }));

    const normalized = normalizeTag(draft);
    const known = this.tagsState.groups().some((group) => group.key === key);
    const alreadyOnNote = onNote.some((tag) => sameTag(tag, draft));
    if (!normalized || known || alreadyOnNote) return available;
    return [{ tag: normalized, create: true, count: 0 }, ...available];
  });

  constructor() {
    // Focus the input as soon as it renders, so Esc works without a click.
    afterRenderEffect(() => this.input()?.nativeElement.focus());
  }

  startAdding(): void {
    this.adding.set(true);
    this.draft.set('');
    this.error.set(null);
    this.activeIndex.set(-1);
    this.input()?.nativeElement.focus();
  }

  protected onInput(field: HTMLInputElement): void {
    // Drop what a tag can't contain as it's typed, rather than rejecting the
    // tag afterwards. A leading `#` is typed out of habit, so it goes too.
    const cleaned = [...field.value.replace(/^#+/, '')].filter(isTagChar).join('');
    if (cleaned !== field.value) field.value = cleaned;
    this.draft.set(cleaned);
    this.error.set(null);
    // With text typed, highlight the top row, the exact or "Create" match.
    this.activeIndex.set(cleaned ? 0 : -1);
  }

  protected onKeydown(event: KeyboardEvent, field: HTMLInputElement): void {
    const suggestions = this.suggestions();
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (suggestions.length === 0) return;
        event.preventDefault();
        // Cycles through the rows and then "none" (-1), i.e. the draft as typed.
        const last = suggestions.length - 1;
        this.activeIndex.update((i) =>
          event.key === 'ArrowDown' ? (i >= last ? -1 : i + 1) : i <= -1 ? last : i - 1,
        );
        return;
      }
      case 'Enter':
      case ',':
      case ' ': {
        event.preventDefault();
        const active = suggestions[this.activeIndex()];
        if (active) this.add(active.tag);
        else if (this.draft()) this.add(this.draft());
        else if (event.key === 'Enter') this.stopAdding();
        return;
      }
      case 'Tab': {
        // Complete to the highlighted (or first) suggestion without adding it.
        const target = suggestions[this.activeIndex()] ?? suggestions[0];
        if (!this.draft() || !target) return;
        event.preventDefault();
        field.value = target.tag;
        this.draft.set(target.tag);
        this.activeIndex.set(0);
        return;
      }
      case 'Backspace': {
        const tags = this.tags();
        if (field.value || tags.length === 0) return;
        event.preventDefault();
        this.remove(tags[tags.length - 1]);
        return;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.stopAdding();
        return;
    }
  }

  protected onBlur(): void {
    if (this.draft() && normalizeTag(this.draft())) this.add(this.draft());
    this.stopAdding();
  }

  protected add(raw: string): void {
    const tag = normalizeTag(raw);
    if (!tag) {
      this.error.set(TAG_RULES);
      return;
    }
    const tags = this.tags();
    if (!tags.some((existing) => sameTag(existing, tag))) {
      // Reuse the vault's spelling of a known tag, so `Idea` typed as `idea`
      // doesn't read as two tags in the sidebar.
      const known = this.tagsState.groups().find((group) => group.key === tagKey(tag));
      this.noteProperties.setTags(this.noteId(), [...tags, known?.name ?? tag]);
    }
    this.draft.set('');
    this.activeIndex.set(-1);
    this.error.set(null);
    const field = this.input()?.nativeElement;
    if (field) field.value = '';
  }

  protected remove(tag: string): void {
    this.noteProperties.setTags(
      this.noteId(),
      this.tags().filter((existing) => existing !== tag),
    );
  }

  protected reveal(tag: string): void {
    this.tagsState.reveal(tag);
  }

  protected onChipContextMenu(event: MouseEvent, tag: string): void {
    this.contextMenuState.open(event, [
      { kind: 'item', label: 'Remove from Note', icon: 'close', action: () => this.remove(tag) },
      { kind: 'item', label: 'Rename Tag Everywhere…', icon: 'rename', action: () => void this.tagActions.rename(tag) },
      { kind: 'separator' },
      { kind: 'item', label: 'Show Notes with Tag', action: () => this.reveal(tag) },
    ]);
  }

  private stopAdding(): void {
    this.adding.set(false);
    this.draft.set('');
    this.error.set(null);
    this.done.emit();
  }
}
