import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { isMobile } from '../../core/tauri-env';

export interface FolderPickRequest {
  title: string;
  confirmLabel: string;
  /** Set when picking where something new goes: the name field's starting value. */
  name?: string;
  /** Limits browsing to this folder and below, which then reads as `rootLabel`. */
  root?: string;
  rootLabel?: string;
  resolve: (path: string | null) => void;
}

/** What the backend's native dialog would ask for, which on Android it is told the answer to instead. */
export type ApprovalKind =
  | 'vault'
  | 'newVault'
  | 'obsidianSource'
  | 'obsidianDest'
  | 'moveTo'
  | 'exportTo'
  | 'copyTo';

const NEW_PATH_KINDS: ReadonlySet<ApprovalKind> = new Set(['newVault', 'obsidianDest', 'moveTo', 'copyTo']);

/**
 * The backend shows the native dialogs on desktop. Android's system picker
 * hands back `content://` URIs rather than paths, so there the in-app
 * `FolderPicker` asks instead and the choice is approved to the backend,
 * which the command that follows consumes.
 */
@Injectable({ providedIn: 'root' })
export class FolderPickerState {
  /** What the in-app picker is asking for; null while it's closed. */
  readonly request = signal<FolderPickRequest | null>(null);
  /** The folder the in-app picker last showed, where it reopens. */
  readonly lastDir = signal<string | null>(null);

  /**
   * Gets `kind`'s path approved before its command runs. True to go ahead:
   * at once on desktop, where the command asks itself; false if cancelled.
   * `defaultName` starts the name field for a path to something new.
   */
  async approve(kind: ApprovalKind, title: string, defaultName = ''): Promise<boolean> {
    if (!isMobile) return true;
    const path = NEW_PATH_KINDS.has(kind)
      ? await this.ask({ title, confirmLabel: 'Save Here', name: defaultName })
      : await this.ask({ title, confirmLabel: 'Use This Folder' });
    if (path === null) return false;
    await invoke('android_approve', { kind, path });
    return true;
  }

  /** A folder inside `root` (Android only), as a path relative to it; '' is `root` itself. */
  async pickFolderIn(title: string, root: string, rootLabel: string): Promise<string | null> {
    const picked = await this.ask({ title, confirmLabel: 'Move Here', root, rootLabel });
    return picked === null ? null : picked.slice(root.length).replace(/^\//, '');
  }

  finish(path: string | null): void {
    const request = this.request();
    this.request.set(null);
    request?.resolve(path);
  }

  private ask(request: Omit<FolderPickRequest, 'resolve'>): Promise<string | null> {
    this.finish(null);
    return new Promise((resolve) => this.request.set({ ...request, resolve }));
  }
}
