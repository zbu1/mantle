import { Component, OnDestroy, computed, inject } from '@angular/core';
import { LucideArrowRight, LucideFileText, LucideFolder } from '@lucide/angular';
import { VaultDragState } from '../../notes/vault-drag-state';

/**
 * Floating badge that follows the cursor while notes are being dragged in
 * the vault tree, showing how many notes are in the drag and — once hovering
 * a valid drop target — which folder they'll land in. Tracks the pointer via
 * a capturing document `dragover` listener rather than a directive-level one
 * so it keeps updating even though folder/root drop targets call
 * `stopPropagation` on their own `dragover` handlers.
 */
@Component({
  selector: 'app-vault-drag-preview',
  imports: [LucideFileText, LucideFolder, LucideArrowRight],
  templateUrl: './vault-drag-preview.html',
})
export class VaultDragPreview implements OnDestroy {
  protected readonly dragState = inject(VaultDragState);

  private readonly onDragOver = (event: DragEvent): void => {
    this.dragState.setPointer(event.clientX, event.clientY);
  };

  private readonly onDragEnd = (): void => {
    this.dragState.endDrag();
  };

  constructor() {
    document.addEventListener('dragover', this.onDragOver, true);
    document.addEventListener('dragend', this.onDragEnd);
  }

  ngOnDestroy(): void {
    document.removeEventListener('dragover', this.onDragOver, true);
    document.removeEventListener('dragend', this.onDragEnd);
  }

  protected readonly style = computed(() => {
    const pointer = this.dragState.pointer();
    if (!pointer) return {};
    return { left: `${pointer.x}px`, top: `${pointer.y}px` };
  });
}
