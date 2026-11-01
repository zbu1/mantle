import { Component, DestroyRef, inject, output, signal } from '@angular/core';
import { redo, undo } from 'prosemirror-history';
import { EditorView } from 'prosemirror-view';
import {
  LucideBold,
  LucideCode,
  LucideHeading,
  LucideHighlighter,
  LucideItalic,
  LucideKeyboardOff,
  LucideLink,
  LucideList,
  LucideListIndentDecrease,
  LucideListIndentIncrease,
  LucideListOrdered,
  LucideListTodo,
  LucideMenu,
  LucideEllipsis,
  LucideRedo2,
  LucideSearch,
  LucideSquarePen,
  LucideSquareSlash,
  LucideStrikethrough,
  LucideTextQuote,
  LucideUndo2,
} from '@lucide/angular';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../shared/context-menu/context-menu.model';
import { FavoritesState } from '../../notes/favorites-state';
import { FindRequestState } from '../../notes/find-request-state';
import { NotesState } from '../../notes/notes-state';
import { countText } from '../../notes/editor/note-editor';
import { parseMarkdown } from '../../notes/editor/prosemirror/markdown-converter';
import { isNotePath } from '../../notes/vault-tree.model';
import { VaultMetaState } from '../../notes/vault-meta-state';
import { SidebarState } from '../sidebar/sidebar-state';
import { EditContextState } from '../../shared/edit-context-state';
import { QuickSwitcherState } from '../../shared/quick-switcher/quick-switcher-state';
import { TabsState } from '../../notes/tabs-state';
import { VaultActions } from '../../notes/vault-actions';
import { schema } from '../../notes/editor/prosemirror/schema';
import {
  executeCommand,
  formatSelection,
  setHeading,
  toggleBlockquote,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
} from '../../notes/editor/prosemirror/editor-commands';
import { indentListItems } from '../../notes/editor/prosemirror/commands/indent-list-items';

type Tool =
  | 'undo'
  | 'redo'
  | 'block'
  | 'heading'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'highlight'
  | 'code'
  | 'link'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'quote'
  | 'indent'
  | 'outdent';

const TOOLS: readonly { id: Tool; label: string }[] = [
  { id: 'undo', label: 'Undo' },
  { id: 'redo', label: 'Redo' },
  { id: 'block', label: 'Insert Block' },
  { id: 'heading', label: 'Heading' },
  { id: 'bold', label: 'Bold' },
  { id: 'italic', label: 'Italic' },
  { id: 'strike', label: 'Strikethrough' },
  { id: 'highlight', label: 'Highlight' },
  { id: 'code', label: 'Inline Code' },
  { id: 'link', label: 'Link to Note' },
  { id: 'bullet', label: 'Bulleted List' },
  { id: 'ordered', label: 'Numbered List' },
  { id: 'task', label: 'Task List' },
  { id: 'quote', label: 'Quote' },
  { id: 'indent', label: 'Indent' },
  { id: 'outdent', label: 'Outdent' },
];

/** Types `text` at the cursor, after a space unless it starts a line or follows one, so the slash and `[[` menus open. */
function typeTrigger(view: EditorView, text: string): void {
  const { $from } = view.state.selection;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset);
  view.dispatch(view.state.tr.insertText(before && !/\s/.test(before) ? ` ${text}` : text));
}

/** The next heading level, H1 → H2 → H3 → back to a paragraph. */
function cycleHeading(view: EditorView): void {
  const block = view.state.selection.$from.parent;
  const level = block.type === schema.nodes['heading'] ? (block.attrs['level'] as number) : 0;
  setHeading(view, level >= 3 ? 3 : level + 1);
}

/**
 * The Android app's bottom bar. Normally it navigates: back, forward, find a
 * note, a new note, the open tabs. While the editor has focus (so the
 * keyboard is up, and this rides on top of it) it's a formatting toolbar.
 * Its buttons never take focus, so tapping one keeps the keyboard open.
 */
@Component({
  selector: 'app-mobile-toolbar',
  imports: [
    LucideMenu,
    LucideEllipsis,
    LucideSearch,
    LucideSquarePen,
    LucideUndo2,
    LucideRedo2,
    LucideSquareSlash,
    LucideHeading,
    LucideBold,
    LucideItalic,
    LucideStrikethrough,
    LucideHighlighter,
    LucideCode,
    LucideLink,
    LucideList,
    LucideListOrdered,
    LucideListTodo,
    LucideTextQuote,
    LucideListIndentIncrease,
    LucideListIndentDecrease,
    LucideKeyboardOff,
  ],
  host: { class: 'frame flex h-12 shrink-0 items-stretch' },
  template: `
    @if (editing()) {
      <div role="toolbar" aria-label="Formatting" class="flex min-w-0 flex-1 items-stretch overflow-x-auto px-1 [scrollbar-width:none]">
        @for (tool of tools; track tool.id) {
          <button type="button" [attr.aria-label]="tool.label" (pointerdown)="$event.preventDefault()" (click)="run(tool.id)"
            class="inline-flex w-11 shrink-0 items-center justify-center rounded-lg text-foreground/80 active:bg-accent">
            @switch (tool.id) {
              @case ('undo') { <svg lucideUndo2 [size]="19"></svg> }
              @case ('redo') { <svg lucideRedo2 [size]="19"></svg> }
              @case ('block') { <svg lucideSquareSlash [size]="19"></svg> }
              @case ('heading') { <svg lucideHeading [size]="19"></svg> }
              @case ('bold') { <svg lucideBold [size]="19"></svg> }
              @case ('italic') { <svg lucideItalic [size]="19"></svg> }
              @case ('strike') { <svg lucideStrikethrough [size]="19"></svg> }
              @case ('highlight') { <svg lucideHighlighter [size]="19"></svg> }
              @case ('code') { <svg lucideCode [size]="19"></svg> }
              @case ('link') { <svg lucideLink [size]="19"></svg> }
              @case ('bullet') { <svg lucideList [size]="19"></svg> }
              @case ('ordered') { <svg lucideListOrdered [size]="19"></svg> }
              @case ('task') { <svg lucideListTodo [size]="19"></svg> }
              @case ('quote') { <svg lucideTextQuote [size]="19"></svg> }
              @case ('indent') { <svg lucideListIndentIncrease [size]="19"></svg> }
              @case ('outdent') { <svg lucideListIndentDecrease [size]="19"></svg> }
            }
          </button>
        }
      </div>
      <button type="button" aria-label="Hide Keyboard" (pointerdown)="$event.preventDefault()" (click)="stopEditing()"
        class="inline-flex w-12 shrink-0 items-center justify-center border-l border-border text-primary active:bg-accent">
        <svg lucideKeyboardOff [size]="19"></svg>
      </button>
    } @else {
      <nav aria-label="Navigation" class="grid flex-1 grid-cols-5">
        <button type="button" aria-label="Vault" (click)="sidebarState.setCollapsed(false)" [class]="navButton">
          <svg lucideMenu [size]="21"></svg>
        </button>
        <button type="button" aria-label="New Note" (click)="newNote()" [class]="navButton">
          <svg lucideSquarePen [size]="21" class="text-primary"></svg>
        </button>
        <button type="button" aria-label="Go to Note" (click)="quickSwitcher.open()" [class]="navButton">
          <svg lucideSearch [size]="21"></svg>
        </button>
        <button type="button" [attr.aria-label]="tabsState.tabs().length + ' open tabs'" (click)="openTabs.emit()" [class]="navButton">
          <span class="inline-flex size-[21px] items-center justify-center rounded-[5px] border-[1.75px] border-current text-[11px] font-semibold tabular-nums leading-none">
            {{ tabsState.tabs().length }}
          </span>
        </button>
        <button type="button" aria-label="More" (click)="openMore($event)" [class]="navButton">
          <svg lucideEllipsis [size]="21"></svg>
        </button>
      </nav>
    }
  `,
})
export class MobileToolbar {
  protected readonly tabsState = inject(TabsState);
  protected readonly quickSwitcher = inject(QuickSwitcherState);
  private readonly vaultActions = inject(VaultActions);
  private readonly editContext = inject(EditContextState);
  protected readonly sidebarState = inject(SidebarState);
  private readonly contextMenu = inject(ContextMenuState);
  private readonly findRequests = inject(FindRequestState);
  private readonly notesState = inject(NotesState);
  private readonly favorites = inject(FavoritesState);
  private readonly vaultMeta = inject(VaultMetaState);

  /** The open-tabs button was tapped. */
  readonly openTabs = output();

  protected readonly tools = TOOLS;
  protected readonly navButton =
    'inline-flex items-center justify-center text-foreground/80 active:bg-accent disabled:text-muted-foreground/40';

  /** The note editor has focus: the keyboard is up. */
  protected readonly editing = signal(false);

  constructor() {
    const track = (event: FocusEvent) => {
      const target = (event.type === 'focusin' ? event.target : event.relatedTarget) as HTMLElement | null;
      this.editing.set(!!target?.closest?.('.ProseMirror'));
    };
    document.addEventListener('focusin', track);
    document.addEventListener('focusout', track);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('focusin', track);
      document.removeEventListener('focusout', track);
    });
  }

  protected run(tool: Tool): void {
    const view = this.editContext.editorView;
    if (!view) return;
    switch (tool) {
      case 'undo': return void executeCommand(view, undo);
      case 'redo': return void executeCommand(view, redo);
      case 'block': return typeTrigger(view, '/');
      case 'heading': return cycleHeading(view);
      case 'bold': return formatSelection(view, 'strong', '**');
      case 'italic': return formatSelection(view, 'em', '*');
      case 'strike': return formatSelection(view, 'strike', '~~');
      case 'highlight': return formatSelection(view, 'highlight', '==');
      case 'code': return formatSelection(view, 'code', '`');
      case 'link': return typeTrigger(view, '[[');
      case 'bullet': return void toggleBulletList(view);
      case 'ordered': return void toggleOrderedList(view);
      case 'task': return void toggleTaskList(view);
      case 'quote': return void toggleBlockquote(view);
      case 'indent': return void executeCommand(view, indentListItems(false));
      case 'outdent': return void executeCommand(view, indentListItems(true));
    }
  }

  protected stopEditing(): void {
    (document.activeElement as HTMLElement | null)?.blur();
  }

  protected openMore(event: MouseEvent): void {
    const tab = this.tabsState.tabs().find((t) => t.id === this.tabsState.activeId());
    const noteId = tab?.noteId;
    const isNote = !!noteId && isNotePath(noteId);
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Back', disabled: !this.tabsState.canGoBack(), action: () => this.tabsState.goBack() },
      { kind: 'item', label: 'Forward', disabled: !this.tabsState.canGoForward(), action: () => this.tabsState.goForward() },
    ];
    if (tab && isNote) {
      const source = this.tabsState.sourceTabs().has(tab.id);
      const content = this.notesState.getNote(noteId)?.content;
      const stats = content === undefined ? null : countText(parseMarkdown(content));
      items.push(
        { kind: 'separator' },
        { kind: 'item', label: 'Find in Note', disabled: source, action: () => this.findRequests.open(false) },
        { kind: 'item', label: 'Replace in Note', disabled: source, action: () => this.findRequests.open(true) },
        { kind: 'item', label: 'Markdown Source', checked: source, action: () => this.tabsState.toggleSource(tab.id) },
      );
      if (this.vaultMeta.loaded()) {
        const favorite = this.favorites.isFavorite(noteId);
        items.push({
          kind: 'item',
          label: favorite ? 'Remove from Favorites' : 'Add to Favorites',
          icon: favorite ? 'unfavorite' : 'favorite',
          action: () => this.favorites.toggle(noteId),
        });
      }
      if (stats) {
        items.push(
          { kind: 'separator' },
          { kind: 'item', label: `${stats.words} ${stats.words === 1 ? 'word' : 'words'} · ${stats.characters} characters`, disabled: true, action: () => undefined },
        );
      }
    }
    this.contextMenu.open(event, items);
  }

  protected newNote(): void {
    void this.vaultActions.createAndOpenNote();
  }
}
