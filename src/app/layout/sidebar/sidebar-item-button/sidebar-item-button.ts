import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';

@Component({
  selector: 'app-sidebar-item-button',
  imports: [],
  templateUrl: './sidebar-item-button.html',
})
export class SidebarItemButton {
  readonly label = input.required<string>();
  /** Dimmed text right after the label, e.g. the `.md` of a plain Markdown file. */
  readonly labelSuffix = input<string | null>(null);
  readonly collapsed = input(false);
  /** Part of a multi-selection in the vault tree: a faint fill. */
  readonly selected = input(false);
  /** The note open in the active tab: an ember rail and a heavier label. */
  readonly active = input(false);
  /** Left padding before `indent`, which lines rows up under their section's header. */
  readonly baseIndent = input(24);
  readonly indent = input(0);
  /** Text to mark within the label, e.g. what the tree filter matched. */
  readonly highlight = input<string | null>(null);
  /** Set by callers that show their own hover tooltip, so the two don't stack. */
  readonly suppressNativeTitle = input(false);
  readonly clicked = output<MouseEvent>();
  readonly middleClicked = output<void>();
  readonly contextMenu = output<MouseEvent>();

  private readonly button = viewChild.required<ElementRef<HTMLButtonElement>>('button');

  /** The label split around the first case-insensitive match of `highlight`, or null for no match. */
  protected readonly labelParts = computed<[string, string, string] | null>(() => {
    const label = this.label();
    const needle = this.highlight()?.trim().toLowerCase();
    const at = needle ? label.toLowerCase().indexOf(needle) : -1;
    if (!needle || at === -1) return null;
    return [label.slice(0, at), label.slice(at, at + needle.length), label.slice(at + needle.length)];
  });

  protected readonly buttonClass = computed(() => {
    const layout = this.collapsed() ? 'h-9 w-full justify-center' : 'w-full py-1 pr-2 text-left mobile:py-2.5 mobile:text-sm';
    // Active and selected stack: the rail and heavier label, plus the fill.
    const rail = this.active()
      ? ' font-medium before:absolute before:inset-y-1 before:left-0.5 before:w-0.5 before:rounded-full before:bg-primary'
      : '';
    const tone = this.selected()
      ? 'bg-foreground/[0.06] text-foreground'
      : this.active()
        ? 'text-foreground hover:bg-surface'
        : 'text-foreground/75 hover:bg-surface hover:text-foreground';
    const focus = this.forceFocusRing() ? ' focus-ring-forced' : '';
    return `focus-ring-inset relative flex items-center gap-2 rounded-md text-xs ${layout} ${tone}${rail}${focus}`;
  });

  // Browsers suppress the native :focus-visible ring for mouse-originated
  // focus, even when we call .focus() ourselves. Clicking a note that's
  // already selected doesn't change anything else on screen, so without a
  // forced ring there's no visible feedback that focus landed here and
  // Tab/Shift+Tab now continue from this item.
  protected readonly forceFocusRing = signal(false);

  protected onClick(event: MouseEvent): void {
    if (this.selected()) {
      this.forceFocusRing.set(true);
      this.button().nativeElement.focus();
    }
    this.clicked.emit(event);
  }

  protected onBlur(): void {
    this.forceFocusRing.set(false);
  }

  protected onContextMenu(event: MouseEvent): void {
    this.contextMenu.emit(event);
  }

  protected onMouseDown(event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
    }
  }

  protected onAuxClick(event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
      this.middleClicked.emit();
    }
  }
}
