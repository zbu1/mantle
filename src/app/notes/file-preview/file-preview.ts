import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { LucideDownload, LucideExternalLink, LucideFileQuestion, LucideFolderOpen } from '@lucide/angular';
import { AttachmentsState, attachmentUrl, isImagePath } from '../attachments-state';
import { VaultState } from '../vault-state';

/**
 * A read-only tab for a file in the vault that isn't a note: an image is
 * shown (decrypted in memory, if sealed); anything else gets an "unsupported"
 * notice with ways to open it outside Mantle — for a sealed one, saving a
 * decrypted copy, never a temporary file.
 */
@Component({
  selector: 'app-file-preview',
  imports: [LucideDownload, LucideExternalLink, LucideFileQuestion, LucideFolderOpen],
  template: `
    @if (isImage() && !failed()) {
      <img [src]="url()" [alt]="relPath()" (error)="failed.set(true)"
        class="absolute inset-0 m-auto max-h-full max-w-full rounded-md object-contain" />
    } @else {
      <div class="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <svg lucideFileQuestion [size]="32" class="text-muted-foreground"></svg>
        <div class="text-sm font-medium text-foreground">
          {{ isImage() ? "This image can't be shown" : 'Unsupported file format' }}
        </div>
        <div class="max-w-md text-xs text-muted-foreground">
          {{ isImage()
            ? 'It may be missing, damaged, or encrypted under a locked profile.'
            : sealed()
              ? "Mantle can't preview this kind of file, and it's encrypted. To open it in another app, save a decrypted copy outside the vault."
              : "Mantle can't preview this kind of file. You can still open it in another app." }}
        </div>
        <div class="mt-1 flex items-center gap-2">
          <button type="button" (click)="vaultState.revealInFileExplorer(relPath())"
            class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface">
            <svg lucideFolderOpen [size]="13"></svg>
            Show in File Explorer
          </button>
          @if (sealed()) {
            @if (!isImage()) {
              <button type="button" (click)="attachments.saveDecryptedCopy(relPath())"
                class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90">
                <svg lucideDownload [size]="13"></svg>
                Save Decrypted Copy As…
              </button>
            }
          } @else {
            <button type="button" (click)="attachments.openInDefaultApp(relPath())"
              class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90">
              <svg lucideExternalLink [size]="13"></svg>
              Open in Default App
            </button>
          }
        </div>
      </div>
    }
  `,
  // Fills what's left of the content area; the image is centered in it,
  // scaled down to fit but never up past its own size.
  host: { class: 'relative block min-h-0 flex-1' },
})
export class FilePreview {
  readonly relPath = input.required<string>();

  protected readonly vaultState = inject(VaultState);
  protected readonly attachments = inject(AttachmentsState);

  protected readonly isImage = computed(() => isImagePath(this.relPath()));
  protected readonly sealed = computed(() => this.relPath().endsWith('.enc'));
  protected readonly url = computed(() => attachmentUrl(this.vaultState.rootPath() ?? '', '', this.relPath()));
  /** The image failed to load; reset when the tab shows another file. */
  protected readonly failed = linkedSignal({ source: this.relPath, computation: () => false });
}
