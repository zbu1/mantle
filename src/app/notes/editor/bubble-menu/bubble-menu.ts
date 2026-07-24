import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import type { Editor } from '@tiptap/core';
import {
  LucideBold,
  LucideCheck,
  LucideCode,
  LucideItalic,
  LucideLink,
  LucideStrikethrough,
  LucideUnlink,
  LucideX,
} from '@lucide/angular';
import { BubbleMenuState } from './bubble-menu-state';

@Component({
  selector: 'app-bubble-menu',
  imports: [LucideBold, LucideItalic, LucideStrikethrough, LucideCode, LucideLink, LucideUnlink, LucideCheck, LucideX],
  templateUrl: './bubble-menu.html',
})
export class BubbleMenuPanel {
  private readonly state = inject(BubbleMenuState);
  protected readonly marks = this.state.activeMarks;

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

  private editor: Editor | undefined;

  protected readonly editingLink = signal(false);
  protected readonly linkUrl = signal('');

  panelElement(): HTMLElement {
    return this.panel().nativeElement;
  }

  setEditor(editor: Editor): void {
    this.editor = editor;
  }

  protected toggleBold(): void {
    this.editor?.chain().focus().toggleBold().run();
  }

  protected toggleItalic(): void {
    this.editor?.chain().focus().toggleItalic().run();
  }

  protected toggleStrike(): void {
    this.editor?.chain().focus().toggleStrike().run();
  }

  protected toggleCode(): void {
    this.editor?.chain().focus().toggleCode().run();
  }

  protected setLinkUrl(value: string): void {
    this.linkUrl.set(value);
  }

  protected openLinkEditor(): void {
    const href = this.editor?.getAttributes('link')['href'] as string | undefined;
    this.linkUrl.set(href ?? '');
    this.editingLink.set(true);
  }

  protected confirmLink(): void {
    const url = this.linkUrl().trim();
    if (!url) {
      this.cancelLink();
      return;
    }
    this.editor?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    this.editingLink.set(false);
  }

  protected cancelLink(): void {
    this.editingLink.set(false);
  }

  protected removeLink(): void {
    this.editor?.chain().focus().unsetLink().run();
  }
}
