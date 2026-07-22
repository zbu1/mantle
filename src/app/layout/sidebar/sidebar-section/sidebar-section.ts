import { Component, computed, inject, input } from '@angular/core';
import { SectionId, SidebarState } from '../sidebar-state';

@Component({
  selector: 'app-sidebar-section',
  imports: [],
  templateUrl: './sidebar-section.html',
})
export class SidebarSection {
  readonly id = input.required<SectionId>();
  readonly label = input.required<string>();

  private readonly state = inject(SidebarState);

  protected readonly expanded = computed(() => this.state.isSectionExpanded(this.id()));

  protected toggle(): void {
    this.state.toggleSection(this.id());
  }
}
