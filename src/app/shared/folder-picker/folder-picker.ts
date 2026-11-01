import { Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import {
  LucideChevronRight,
  LucideCornerLeftUp,
  LucideFolder,
  LucideFolders,
  LucideSmartphone,
  LucideX,
} from '@lucide/angular';
import { androidBridge } from '../../core/tauri-env';
import { formatError } from '../../core/logger';
import { FolderPickerState } from './folder-picker-state';

/** Mirrors `FolderEntry` in `vault.rs`. */
interface FolderEntry {
  name: string;
  vault: boolean;
}

/** A name for something new: not empty, no separators, nothing the filesystem treats specially. */
function nameError(name: string): string | null {
  if (!name) return 'Give it a name.';
  if (/[/\\]/.test(name)) return "A name can't contain / or \\.";
  if (name === '.' || name === '..' || name.startsWith('.')) return "A name can't start with a dot.";
  return null;
}

/**
 * Android's stand-in for the native folder dialogs (see `FolderPickerState`):
 * a full-screen browser of shared storage, from which the user picks the
 * folder shown, or names something new inside it.
 */
@Component({
  selector: 'app-folder-picker',
  imports: [LucideX, LucideFolder, LucideFolders, LucideChevronRight, LucideCornerLeftUp, LucideSmartphone],
  template: `
    @if (state.request(); as request) {
      <div role="dialog" aria-modal="true" [attr.aria-label]="request.title"
        class="animate-pop-in fixed inset-0 z-[70] flex flex-col bg-background text-foreground">
        <header class="frame flex h-12 shrink-0 items-center gap-1 border-b border-border px-1.5">
          <button type="button" aria-label="Cancel" (click)="state.finish(null)"
            class="inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground active:bg-accent">
            <svg lucideX [size]="20"></svg>
          </button>
          <h2 class="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">{{ request.title }}</h2>
        </header>

        <nav aria-label="Folder" class="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1.5 text-sm">
          @for (crumb of crumbs(); track crumb.path; let first = $first; let last = $last) {
            @if (!first) {
              <svg lucideChevronRight [size]="14" class="shrink-0 text-muted-foreground/60"></svg>
            }
            <button type="button" (click)="go(crumb.path)" [attr.aria-current]="last ? 'location' : null"
              class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 active:bg-accent"
              [class.font-semibold]="last" [class.text-muted-foreground]="!last">
              @if (first) {
                <svg lucideSmartphone [size]="15"></svg>
              }
              {{ crumb.name }}
            </button>
          }
        </nav>

        <ul class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1">
          @if (dir() !== root()) {
            <li>
              <button type="button" (click)="up()"
                class="flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-muted-foreground active:bg-accent">
                <svg lucideCornerLeftUp [size]="18"></svg>
                <span class="text-sm">Up one level</span>
              </button>
            </li>
          }
          @for (folder of folders(); track folder.name) {
            <li>
              <button type="button" (click)="go(dir() + '/' + folder.name)"
                class="flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left active:bg-accent">
                @if (folder.vault) {
                  <svg lucideFolders [size]="18" class="shrink-0 text-primary"></svg>
                } @else {
                  <svg lucideFolder [size]="18" class="shrink-0 text-muted-foreground"></svg>
                }
                <span class="min-w-0 flex-1 truncate text-sm">{{ folder.name }}</span>
                @if (folder.vault) {
                  <span class="shrink-0 text-xs text-muted-foreground">Vault</span>
                }
                <svg lucideChevronRight [size]="16" class="shrink-0 text-muted-foreground/60"></svg>
              </button>
            </li>
          } @empty {
            @if (!loading()) {
              <li class="px-3 py-6 text-center text-sm text-muted-foreground">{{ error() ?? 'No folders here.' }}</li>
            }
          }
        </ul>

        <footer class="frame flex shrink-0 flex-col gap-2 border-t border-border p-3">
          @if (request.name !== undefined) {
            <label class="flex flex-col gap-1">
              <span class="text-xs font-medium text-muted-foreground">Name</span>
              <input #nameInput type="text" [value]="name()" (input)="name.set(nameInput.value)" autocomplete="off"
                spellcheck="false" (keydown.enter)="confirm()"
                class="h-11 rounded-lg border border-input bg-background px-3 text-base outline-none focus:border-ring" />
            </label>
          }
          <p class="truncate text-xs text-muted-foreground" [class.text-destructive]="!!invalid()">{{ invalid() ?? target() }}</p>
          <button type="button" (click)="confirm()" [disabled]="!!invalid()"
            class="h-11 rounded-lg bg-primary text-sm font-semibold text-primary-foreground active:opacity-90 disabled:opacity-50">
            {{ request.confirmLabel }}
          </button>
        </footer>
      </div>
    }
  `,
})
export class FolderPicker {
  protected readonly state = inject(FolderPickerState);

  protected readonly root = signal('/storage/emulated/0');
  protected readonly dir = signal('');
  protected readonly folders = signal<FolderEntry[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly name = signal('');

  protected readonly crumbs = computed(() => {
    const root = this.root();
    const parts = this.dir().slice(root.length).split('/').filter(Boolean);
    return [
      { name: this.state.request()?.rootLabel ?? 'Phone', path: root },
      ...parts.map((name, i) => ({ name, path: `${root}/${parts.slice(0, i + 1).join('/')}` })),
    ];
  });

  /** What confirming hands back. */
  protected readonly target = computed(() =>
    this.state.request()?.name !== undefined ? `${this.dir()}/${this.name().trim()}` : this.dir(),
  );

  protected readonly invalid = computed(() => {
    if (this.state.request()?.name === undefined) return null;
    const name = this.name().trim();
    return nameError(name) ?? (this.folders().some((f) => f.name === name) ? `"${name}" already exists here.` : null);
  });

  constructor() {
    effect(() => {
      const request = this.state.request();
      if (!request) return;
      untracked(() => {
        const root = request.root ?? androidBridge()?.storageRoot() ?? this.root();
        this.root.set(root);
        this.name.set(request.name ?? '');
        void this.go(request.root ?? this.state.lastDir() ?? `${root}/Documents`, root);
      });
    });
  }

  /** Shows `path`, or `fallback` if it can't be read (say, a folder that's gone since). */
  protected async go(path: string, fallback?: string): Promise<void> {
    this.loading.set(true);
    try {
      this.folders.set(await invoke<FolderEntry[]>('browse_folders', { path }));
      this.dir.set(path);
      this.error.set(null);
      if (!this.state.request()?.root) this.state.lastDir.set(path);
    } catch (err) {
      if (fallback && fallback !== path) return this.go(fallback);
      this.dir.set(path);
      this.folders.set([]);
      this.error.set(`Couldn't open this folder: ${formatError(err)}`);
    } finally {
      this.loading.set(false);
    }
  }

  protected up(): void {
    void this.go(this.dir().slice(0, this.dir().lastIndexOf('/')));
  }

  protected confirm(): void {
    if (!this.invalid()) this.state.finish(this.target());
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.state.request()) this.state.finish(null);
  }
}
