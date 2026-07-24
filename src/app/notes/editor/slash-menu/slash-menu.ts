import { Component, ElementRef, inject, viewChild } from '@angular/core';
import {
  LucideCode2,
  LucideHeading1,
  LucideHeading2,
  LucideHeading3,
  LucideList,
  LucideListOrdered,
  LucideListTodo,
  LucideMinus,
  LucideQuote,
} from '@lucide/angular';
import { SlashMenuState } from './slash-menu-state';
import { SlashCommandItem } from './slash-menu.model';

@Component({
  selector: 'app-slash-menu',
  imports: [
    LucideHeading1,
    LucideHeading2,
    LucideHeading3,
    LucideList,
    LucideListOrdered,
    LucideListTodo,
    LucideQuote,
    LucideCode2,
    LucideMinus,
  ],
  templateUrl: './slash-menu.html',
})
export class SlashMenu {
  private readonly state = inject(SlashMenuState);

  protected readonly items = this.state.items;
  protected readonly selectedIndex = this.state.selectedIndex;

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

  panelElement(): HTMLElement {
    return this.panel().nativeElement;
  }

  protected select(item: SlashCommandItem): void {
    this.state.selectItem(item);
  }
}
