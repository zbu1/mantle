import { Component, ElementRef, computed, effect, inject, input, linkedSignal, viewChild } from '@angular/core';
import { LucideDownload, LucideExternalLink, LucideFileQuestion, LucideFolderOpen } from '@lucide/angular';
import { formatError, logError } from '../../core/logger';
import { AttachmentsState, attachmentUrl, isImagePath, isPdfPath, isVideoPath } from '../attachments-state';
import { VaultState } from '../vault-state';
import { renderPdfPages } from '../pdf-pages';

/**
 * A read-only tab for a file in the vault that isn't a note: an image, video
 * or PDF is shown (decrypted in memory, if sealed); anything else gets an "unsupported"
 * notice with ways to open it outside Mantle — for a sealed one, saving a
 * decrypted copy, never a temporary file.
 */
@Component({
  selector: 'app-file-preview',
  imports: [LucideDownload, LucideExternalLink, LucideFileQuestion, LucideFolderOpen],
  template: `
    @if (kind() === 'image' && !failed()) {
      <img [src]="url()" [alt]="relPath()" (error)="failed.set(true)"
        class="absolute inset-0 m-auto max-h-full max-w-full rounded-md object-contain" />
    } @else if (kind() === 'video' && !failed()) {
      <video [src]="url()" controls (error)="failed.set(true)"
        class="absolute inset-0 m-auto max-h-full max-w-full rounded-md"></video>
    } @else if (kind() === 'pdf' && !failed()) {
      <div #pages class="absolute inset-0 flex flex-col items-center gap-4 overflow-auto bg-surface py-6"></div>
    } @else {
      <div class="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <svg lucideFileQuestion [size]="32" class="text-muted-foreground"></svg>
        <div class="text-sm font-medium text-foreground">
          {{ kind() ? "This file can't be shown" : 'Unsupported file format' }}
        </div>
        <div class="max-w-md text-xs text-muted-foreground">
          {{ kind()
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
            @if (!kind()) {
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

  protected readonly kind = computed(() => {
    const path = this.relPath();
    return isImagePath(path) ? 'image' : isVideoPath(path) ? 'video' : isPdfPath(path) ? 'pdf' : null;
  });
  protected readonly sealed = computed(() => this.relPath().endsWith('.enc'));
  protected readonly url = computed(() => attachmentUrl(this.vaultState.rootPath() ?? '', '', this.relPath()));
  /** The file failed to load; reset when the tab shows another file. */
  protected readonly failed = linkedSignal({ source: this.relPath, computation: () => false });
  private readonly pages = viewChild<ElementRef<HTMLElement>>('pages');

  constructor() {
    effect((onCleanup) => {
      const host = this.pages()?.nativeElement;
      if (!host) return;
      let stop: (() => void) | null = null;
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
        stop?.();
      });
      renderPdfPages(this.url(), host, host, 'shrink-0 bg-white shadow-card').then(
        (done) => (cancelled ? done() : (stop = done)),
        (err) => {
          logError(`Failed to show PDF: ${formatError(err)}`);
          if (!cancelled) this.failed.set(true);
        },
      );
    });
  }
}
