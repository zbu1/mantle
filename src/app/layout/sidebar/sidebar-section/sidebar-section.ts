import { Component, computed, inject, input } from '@angular/core';
import { LucideChevronRight } from '@lucide/angular';
import { SectionId, SidebarState } from '../sidebar-state';

@Component({
  selector: 'app-sidebar-section',
  imports: [LucideChevronRight],
  templateUrl: './sidebar-section.html',
  host: { class: 'flex flex-col rounded-md' },
})
export class SidebarSection {
  readonly id = input.required<SectionId>();
  readonly label = input.required<string>();

  protected readonly state = inject(SidebarState);

  protected readonly expanded = computed(() => this.state.isSectionExpanded(this.id()));

  protected toggle(): void {
    this.state.toggleSection(this.id());
  }
}
