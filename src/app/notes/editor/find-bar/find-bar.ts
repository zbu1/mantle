import { Component, ElementRef, afterNextRender, effect, input, model, output, signal, untracked, viewChild } from '@angular/core';
import {
  LucideCaseSensitive,
  LucideChevronDown,
  LucideChevronUp,
  LucideRegex,
  LucideWholeWord,
  LucideX,
} from '@lucide/angular';
import { NoteEditor } from '../note-editor';
import { findNext, queryRegExp, replaceAll, replaceCurrent, setFindQuery } from '../prosemirror/plugins/find-plugin';

/**
 * Find (and, with `replace`, replace) in the pane's note. Enter / Shift+Enter
 * go to the next / previous match; Esc closes the bar and returns to the note.
 */
@Component({
  selector: 'app-find-bar',
  imports: [LucideCaseSensitive, LucideChevronDown, LucideChevronUp, LucideRegex, LucideWholeWord, LucideX],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-1 rounded-md border border-border bg-background p-1 text-xs shadow-card" (keydown.escape)="close($event)">
      <div class="flex items-center gap-1 mobile:flex-wrap">
        <input #findInput type="text" placeholder="Find" spellcheck="false" aria-label="Find" [value]="text()"
          (input)="text.set(findInput.value)" (keydown.enter)="next($event)"
          [class.text-destructive]="invalid()"
          class="h-7 min-w-0 flex-1 rounded border border-input bg-transparent px-2 text-foreground outline-none focus:border-ring mobile:order-1 mobile:h-10 mobile:w-[calc(100%-2.75rem)] mobile:flex-none mobile:text-base" />
        @for (toggle of toggles; track toggle.key) {
          <button type="button" [title]="toggle.title" [attr.aria-pressed]="toggle.value()" (click)="toggle.value.set(!toggle.value())"
            class="inline-flex size-7 shrink-0 items-center justify-center rounded hover:bg-surface mobile:order-2 mobile:size-10"
            [class.text-primary]="toggle.value()" [class.bg-accent]="toggle.value()" [class.text-muted-foreground]="!toggle.value()">
            @switch (toggle.key) {
              @case ('case') { <svg lucideCaseSensitive [size]="15"></svg> }
              @case ('word') { <svg lucideWholeWord [size]="15"></svg> }
              @case ('regex') { <svg lucideRegex [size]="15"></svg> }
            }
          </button>
        }
        <span class="w-16 shrink-0 text-center mobile:order-2 mobile:flex-1 text-muted-foreground tabular-nums">
          {{ status().total ? status().current + ' of ' + status().total : text() ? 'No results' : '' }}
        </span>
        <button type="button" title="Previous match (Shift+Enter)" (click)="go(true)" [disabled]="!status().total"
          class="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface hover:text-foreground disabled:opacity-40 mobile:order-2 mobile:size-10">
          <svg lucideChevronUp [size]="15"></svg>
        </button>
        <button type="button" title="Next match (Enter)" (click)="go(false)" [disabled]="!status().total"
          class="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface hover:text-foreground disabled:opacity-40 mobile:order-2 mobile:size-10">
          <svg lucideChevronDown [size]="15"></svg>
        </button>
        <button type="button" title="Close (Esc)" (click)="close()"
          class="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface hover:text-foreground mobile:order-1 mobile:size-10">
          <svg lucideX [size]="14"></svg>
        </button>
      </div>
      @if (replace()) {
        <div class="flex items-center gap-1 mobile:flex-wrap">
          <input #replaceInput type="text" placeholder="Replace" spellcheck="false" aria-label="Replace" [value]="replacement()"
            (input)="replacement.set(replaceInput.value)" (keydown.enter)="replaceOne($event)"
            class="h-7 min-w-0 flex-1 rounded border border-input bg-transparent px-2 text-foreground outline-none focus:border-ring mobile:h-10 mobile:w-full mobile:flex-none mobile:text-base" />
          <button type="button" (click)="replaceOne()" [disabled]="!status().total"
            class="h-7 shrink-0 rounded px-2 mobile:h-10 mobile:flex-1 text-foreground hover:bg-surface disabled:opacity-40">Replace</button>
          <button type="button" (click)="replaceEvery()" [disabled]="!status().total"
            class="h-7 shrink-0 rounded px-2 mobile:h-10 mobile:flex-1 text-foreground hover:bg-surface disabled:opacity-40">Replace All</button>
        </div>
      }
    </div>
  `,
})
export class FindBar {
  readonly editor = input.required<NoteEditor>();
  readonly replace = model(false);
  readonly closed = output<void>();

  private readonly findInput = viewChild.required<ElementRef<HTMLInputElement>>('findInput');

  protected readonly text = signal('');
  protected readonly replacement = signal('');
  private readonly matchCase = signal(false);
  private readonly wholeWord = signal(false);
  private readonly regex = signal(false);
  protected readonly toggles = [
    { key: 'case', title: 'Match case', value: this.matchCase },
    { key: 'word', title: 'Whole word', value: this.wholeWord },
    { key: 'regex', title: 'Regular expression', value: this.regex },
  ];
  private readonly query = () => ({ text: this.text(), matchCase: this.matchCase(), wholeWord: this.wholeWord(), regex: this.regex() });
  protected readonly invalid = () => !!this.text() && !queryRegExp(this.query());
  protected readonly status = () => this.editor().findStatus();

  constructor() {
    afterNextRender(() => this.focus());
    effect(() => {
      const query = this.query();
      const view = this.editor().view;
      if (view) untracked(() => setFindQuery(view, query));
    });
  }

  /** Focuses the find field with its text selected, e.g. when Ctrl+F is pressed again. */
  focus(): void {
    const field = this.findInput().nativeElement;
    field.focus();
    field.select();
  }

  protected next(event: Event): void {
    event.preventDefault();
    this.go((event as KeyboardEvent).shiftKey);
  }

  protected go(backward: boolean): void {
    const view = this.editor().view;
    if (view) findNext(view, backward);
  }

  protected replaceOne(event?: Event): void {
    event?.preventDefault();
    const view = this.editor().view;
    if (view) replaceCurrent(view, this.replacement());
  }

  protected replaceEvery(): void {
    const view = this.editor().view;
    if (view) replaceAll(view, this.replacement());
  }

  close(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const view = this.editor().view;
    if (view) {
      setFindQuery(view, null);
      view.focus();
    }
    this.closed.emit();
  }
}
