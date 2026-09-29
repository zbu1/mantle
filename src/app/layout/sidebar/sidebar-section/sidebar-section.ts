import { Component, computed, inject, input } from '@angular/core';
import { LucideChevronRight } from '@lucide/angular';
import { ContextMenuState } from '../../../shared/context-menu/context-menu-state';
import { ContextMenuItem } from '../../../shared/context-menu/context-menu.model';
import { SectionId, SIDEBAR_SECTIONS, SidebarState } from '../sidebar-state';

@Component({
  selector: 'app-sidebar-section',
  imports: [LucideChevronRight],
  templateUrl: './sidebar-section.html',
  host: { class: 'flex flex-col' },
})
export class SidebarSection {
  readonly id = input.required<SectionId>();
  readonly label = input.required<string>();
  /** How many items the section holds, shown quietly after the label. Hidden when null or 0. */
  readonly count = input<number | null>(null);

  protected readonly state = inject(SidebarState);
  private readonly contextMenuState = inject(ContextMenuState);

  protected readonly expanded = computed(() => this.state.isSectionExpanded(this.id()));

  protected toggle(): void {
    this.state.toggleSection(this.id());
  }

  /** Right-click on the header: a checklist of every sidebar section, toggling which are shown. */
  protected onHeaderContextMenu(event: MouseEvent): void {
    const items: ContextMenuItem[] = SIDEBAR_SECTIONS.map((section) => ({
      kind: 'item',
      label: section.label,
      checked: this.state.isSectionVisible(section.id),
      action: () => this.state.toggleSectionVisibility(section.id),
    }));
    this.contextMenuState.open(event, items);
  }
}
