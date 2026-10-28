import { Component, ElementRef, inject, viewChild } from '@angular/core';
import {
  LucideCode2,
  LucideHeading1,
  LucideHeading2,
  LucideHeading3,
  LucideImage,
  LucideList,
  LucideListOrdered,
  LucideListTodo,
  LucideMinus,
  LucideQuote,
  LucideTable,
  LucideTags,
  LucideText,
} from '@lucide/angular';
import { MenuItem } from '../../../shared/menu/menu-item';
import { MenuSurface } from '../../../shared/menu/menu-surface';
import { SlashMenuState } from './slash-menu-state';
import { SlashCommandItem } from './slash-menu.model';

@Component({
  selector: 'app-slash-menu',
  imports: [
    MenuSurface,
    MenuItem,
    LucideHeading1,
    LucideHeading2,
    LucideHeading3,
    LucideList,
    LucideListOrdered,
    LucideListTodo,
    LucideQuote,
    LucideTable,
    LucideCode2,
    LucideMinus,
    LucideImage,
    LucideTags,
    LucideText,
  ],
  templateUrl: './slash-menu.html',
})
export class SlashMenu {
  private readonly state = inject(SlashMenuState);

  protected readonly items = this.state.items;
  protected readonly selectedIndex = this.state.selectedIndex;

  // #panel is an <app-menu-surface>; the slash-menu plugin positions and shows
  // the host element directly, so read ElementRef instead of the instance.
  private readonly panel = viewChild.required('panel', { read: ElementRef<HTMLElement> });

  panelElement(): HTMLElement {
    return this.panel().nativeElement;
  }

  protected select(item: SlashCommandItem): void {
    this.state.selectItem(item);
  }

  protected hover(index: number): void {
    this.state.setSelectedIndex(index);
  }
}
