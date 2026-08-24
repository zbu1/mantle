import { Component, computed, inject, input } from '@angular/core';
import { LucideChevronRight } from '@lucide/angular';
import { SectionId, SidebarState } from '../sidebar-state';

@Component({
  selector: 'app-sidebar-section',
  imports: [LucideChevronRight],
  templateUrl: './sidebar-section.html',
})
export class SidebarSection {
  readonly id = input.required<SectionId>();
  readonly label = input.required<string>();
  // Pins the header to the top of the nearest scrolling ancestor, e.g. for
  // sections (like the vault tree) whose content scrolls independently.
  readonly stickyHeader = input(false);

  private readonly state = inject(SidebarState);

  protected readonly expanded = computed(() => this.state.isSectionExpanded(this.id()));

  protected toggle(): void {
    this.state.toggleSection(this.id());
  }
}
