import { Component, ElementRef, HostListener, afterNextRender, computed, input, output, signal, viewChild } from '@angular/core';
import { LucideCheck } from '@lucide/angular';
import { MenuItem } from '../../../shared/menu/menu-item';
import { MenuSurface } from '../../../shared/menu/menu-surface';
import { languageId, matchLanguages } from '../prosemirror/code-languages';

// Matches the w-56 / max-h-72 of a scrollable MenuSurface.
const PANEL_WIDTH = 224;
const PANEL_HEIGHT = 288;
const GAP = 4;
const VIEWPORT_MARGIN = 8;

const PLAIN_TEXT = { id: '', name: 'Plain text' };

/** The filterable language list a code block's language label opens. */
@Component({
  selector: 'app-code-language-picker',
  imports: [MenuSurface, MenuItem, LucideCheck],
  template: `
    <app-menu-surface #panel [scrollable]="true" class="fixed z-50 !pt-0" [style]="style()">
      <div class="sticky top-0 z-10 bg-surface px-2 pt-2 pb-1">
        <input #filter type="text" placeholder="Filter languages" aria-label="Filter languages"
          (input)="onFilter(filter.value)" (keydown)="onKeydown($event)"
          class="w-full rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-ring" />
      </div>
      @for (option of options(); track option.id) {
        <app-menu-item [label]="option.name" [active]="$index === activeIndex()" (hovered)="activeIndex.set($index)"
          (selected)="picked.emit(option.id)">
          @if (option.id === currentId()) {
            <svg menuItemTrailing lucideCheck [size]="12"></svg>
          }
        </app-menu-item>
      } @empty {
        <div class="px-3 py-1.5 text-xs text-muted-foreground">No matching languages</div>
      }
    </app-menu-surface>
  `,
})
export class CodeLanguagePicker {
  /** The language label it drops down from. */
  readonly anchor = input.required<HTMLElement>();
  /** The block's current fence info string. */
  readonly current = input('');
  /** The chosen language id; empty for plain text. */
  readonly picked = output<string>();
  readonly closed = output<void>();

  private readonly panel = viewChild.required('panel', { read: ElementRef<HTMLElement> });
  private readonly filter = viewChild.required<ElementRef<HTMLInputElement>>('filter');

  private readonly query = signal('');
  protected readonly activeIndex = signal(0);
  protected readonly currentId = computed(() => languageId(this.current()) ?? '');

  protected readonly options = computed(() => {
    const q = this.query().trim().toLowerCase();
    const plain = !q || PLAIN_TEXT.name.toLowerCase().includes(q) ? [PLAIN_TEXT] : [];
    return [...plain, ...matchLanguages(q)];
  });

  protected readonly style = computed(() => {
    const rect = this.anchor().getBoundingClientRect();
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN));
    const fitsBelow = rect.bottom + GAP + PANEL_HEIGHT + VIEWPORT_MARGIN <= window.innerHeight;
    const top = fitsBelow ? rect.bottom + GAP : Math.max(VIEWPORT_MARGIN, rect.top - GAP - PANEL_HEIGHT);
    return { left: `${left}px`, top: `${top}px` };
  });

  constructor() {
    afterNextRender(() => this.filter().nativeElement.focus());
  }

  protected onFilter(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.options().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!count) return;
      this.activeIndex.update((i) => (i + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
      this.panel().nativeElement.querySelectorAll('app-menu-item')[this.activeIndex()]?.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = this.options()[this.activeIndex()];
      if (option) this.picked.emit(option.id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.closed.emit();
    }
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    // The anchor toggles the picker itself.
    const inside = [this.panel().nativeElement, this.anchor()].some((el) => event.target instanceof Node && el.contains(event.target));
    if (inside) return;
    this.closed.emit();
  }
}
