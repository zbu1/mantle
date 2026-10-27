import { Injectable, signal } from '@angular/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { isMobile } from '../../core/tauri-env';

export interface FolderPickRequest {
  title: string;
  confirmLabel: string;
  /** Set when picking where something new goes: the name field's starting value. */
  name?: string;
  resolve: (path: string | null) => void;
}

/**
 * Asks for a folder, or for where something new should go. The native dialogs
 * on desktop; on Android, whose system picker hands back `content://` URIs
 * rather than paths, the in-app `FolderPicker` instead.
 */
@Injectable({ providedIn: 'root' })
export class FolderPickerState {
  /** What the in-app picker is asking for; null while it's closed. */
  readonly request = signal<FolderPickRequest | null>(null);
  /** The folder the in-app picker last showed, where it reopens. */
  readonly lastDir = signal<string | null>(null);

  /** An existing folder. */
  async pickFolder(title: string): Promise<string | null> {
    if (isMobile) return this.ask({ title, confirmLabel: 'Use This Folder' });
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === 'string' ? picked : null;
  }

  /** A path for something new: a folder to put it in and the name it gets there, `defaultPath`'s to start with. */
  pickNewPath(title: string, defaultPath: string): Promise<string | null> {
    if (isMobile) return this.ask({ title, confirmLabel: 'Save Here', name: defaultPath.split(/[/\\]/).pop() ?? '' });
    return save({ title, defaultPath });
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
