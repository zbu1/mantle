import { Injectable, signal } from '@angular/core';
import { SlashCommandItem } from './slash-menu.model';

@Injectable({ providedIn: 'root' })
export class SlashMenuState {
  readonly items = signal<SlashCommandItem[]>([]);
  readonly selectedIndex = signal(0);

  private confirm: ((item: SlashCommandItem) => void) | undefined;

  show(items: SlashCommandItem[], confirm: (item: SlashCommandItem) => void): void {
    this.items.set(items);
    this.selectedIndex.set(0);
    this.confirm = confirm;
  }

  updateItems(items: SlashCommandItem[]): void {
    this.items.set(items);
    this.selectedIndex.set(0);
  }

  moveSelection(delta: number): void {
    const count = this.items().length;
    if (count === 0) return;
    this.selectedIndex.update((index) => (index + delta + count) % count);
  }

  confirmSelected(): void {
    const item = this.items()[this.selectedIndex()];
    if (item) this.confirm?.(item);
  }

  selectItem(item: SlashCommandItem): void {
    this.confirm?.(item);
  }

  hide(): void {
    this.items.set([]);
    this.selectedIndex.set(0);
    this.confirm = undefined;
  }
}
