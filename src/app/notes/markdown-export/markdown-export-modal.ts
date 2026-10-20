import { Component, ElementRef, HostListener, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { LucideFileDown, LucideLock, LucideLockOpen } from '@lucide/angular';
import { open } from '@tauri-apps/plugin-dialog';
import { formatError } from '../../core/logger';
import { CredentialsState } from '../credentials-state';
import { VaultState } from '../vault-state';
import { VaultNoteNode, flattenAllNotes } from '../vault-tree.model';
import { MarkdownExportState, Placement } from './markdown-export-state';

type PlacementKind = Placement['kind'];

interface ProfileRow {
  id: string;
  name: string;
  count: number;
  unlocked: boolean;
  /** Whether this vault has the profile, so it can be unlocked. */
  known: boolean;
}

/** Mantle's own attachment folder in the vault root, which converted notes' attachments must leave. */
const MANAGED_DIR = 'attachments';

/**
 * The modal behind "Convert to Markdown…" and "Export Vault as Markdown…":
 * says which profiles' notes are included, picks where attachments go, and
 * for an export, the destination folder. Rendered once at the layout root.
 */
@Component({
  selector: 'app-markdown-export-modal',
  imports: [LucideFileDown, LucideLock, LucideLockOpen],
  templateUrl: './markdown-export-modal.html',
})
export class MarkdownExportModal {
  private readonly state = inject(MarkdownExportState);
  private readonly credentialsState = inject(CredentialsState);
  private readonly vaultState = inject(VaultState);

  protected readonly request = this.state.request;
  protected readonly exporting = computed(() => this.request()?.mode === 'export');

  protected readonly placementKind = signal<PlacementKind>('subfolder');
  protected readonly subfolder = signal(MANAGED_DIR);
  protected readonly folder = signal('');
  protected readonly removeUnused = signal(false);
  protected readonly dest = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The notes this would write out: the selection, or every note in the tree. */
  private readonly notes = computed<readonly VaultNoteNode[]>(() => {
    const request = this.request();
    if (request?.mode === 'convert') return request.notes;
    const tree = this.vaultState.tree();
    return tree ? flattenAllNotes(tree) : [];
  });

  protected readonly heading = computed(() => {
    if (this.exporting()) return 'Export vault as Markdown';
    const notes = this.notes();
    return notes.length === 1 ? `Convert "${notes[0].name}" to Markdown` : `Convert ${notes.length} notes to Markdown`;
  });

  protected readonly plaintextCount = computed(() => this.notes().filter((n) => !n.encrypted).length);

  /** Every profile with notes involved, and for an export every profile there is, with whether its notes are included. */
  protected readonly profiles = computed<ProfileRow[]>(() => {
    const counts = new Map<string, number>();
    for (const note of this.notes()) {
      if (note.encrypted) counts.set(note.profile ?? '', (counts.get(note.profile ?? '') ?? 0) + 1);
    }
    if (this.exporting()) {
      for (const profile of this.credentialsState.profiles()) counts.set(profile.id, counts.get(profile.id) ?? 0);
      for (const [id, n] of Object.entries(this.vaultState.lockedHidden())) counts.set(id, (counts.get(id) ?? 0) + n);
    }
    return [...counts].map(([id, count]) => {
      const profile = this.credentialsState.profileById(id || null);
      return {
        id,
        name: profile?.displayName ?? (id || 'Unreadable notes'),
        count,
        unlocked: profile?.unlocked ?? false,
        known: !!profile,
      };
    });
  });

  /** Why the attachment folder can't be used, or null. */
  protected readonly placementError = computed<string | null>(() => {
    const rootNotes = this.notes().some((n) => !n.relPath.includes('/'));
    switch (this.placementKind()) {
      case 'subfolder': {
        const name = this.subfolder().trim();
        if (!name) return 'Name the attachment folder.';
        if (/[/\\:]/.test(name)) return 'A folder name can\'t contain /, \\ or :.';
        if (name.startsWith('.')) return 'The attachment folder can\'t be a hidden (dot) folder.';
        if (name === MANAGED_DIR && rootNotes) {
          return `Notes in the vault root would put theirs in Mantle's own "${MANAGED_DIR}" folder. Pick another name.`;
        }
        return null;
      }
      case 'folder': {
        const path = this.folder().trim().replace(/^\/+|\/+$/g, '');
        if (!path) return 'Enter a folder, relative to the vault root.';
        const parts = path.split('/');
        if (parts.some((p) => !p || p.startsWith('.') || /[\\:]/.test(p))) return 'That isn\'t a valid folder in the vault.';
        if (parts[0] === MANAGED_DIR) return `"${MANAGED_DIR}" is Mantle's own folder. Pick another.`;
        return null;
      }
      default:
        return null;
    }
  });

  protected readonly disabledReason = computed<string | null>(() => {
    if (this.busy()) return null;
    const placementError = this.placementError();
    if (placementError) return placementError;
    if (this.exporting()) return this.dest() ? null : 'Choose a new or empty folder to export to.';
    const readable = this.notes().some((n) => !n.encrypted || this.credentialsState.isUnlocked(n.profile));
    return readable ? null : 'Every note here is in a locked profile. Unlock one above to continue.';
  });

  protected readonly confirmLabel = computed(() => (this.busy() ? 'Working…' : this.exporting() ? 'Export' : 'Convert'));

  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');

  constructor() {
    effect(() => {
      if (this.request()) untracked(() => this.reset());
    });
    effect(() => this.dialog()?.nativeElement.focus());
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.request() && !this.busy()) this.state.close();
  }

  protected onBackdropPointerDown(event: PointerEvent): void {
    if (event.target === event.currentTarget && !this.busy()) this.state.close();
  }

  protected close(): void {
    this.state.close();
  }

  protected async unlock(profileId: string): Promise<void> {
    await this.credentialsState.promptUnlock(profileId);
  }

  protected async chooseDest(): Promise<void> {
    const picked = await open({ directory: true, multiple: false, title: 'Export to a new or empty folder' });
    if (typeof picked === 'string') {
      this.dest.set(picked);
      this.error.set(null);
    }
  }

  protected async submit(): Promise<void> {
    const request = this.request();
    if (!request || this.busy() || this.disabledReason() !== null) return;
    const placement = this.placement();
    this.busy.set(true);
    this.error.set(null);
    try {
      if (request.mode === 'export') {
        const dest = this.dest();
        if (!dest) return;
        await this.state.export(dest, placement);
        this.state.close();
      } else {
        // Closed first: a name clash asks in the shared dialog, which mustn't sit behind this one.
        this.state.close();
        await this.state.convert(request.notes, placement, this.removeUnused());
      }
    } catch (err) {
      if (this.request()) this.error.set(formatError(err));
    } finally {
      this.busy.set(false);
    }
  }

  private placement(): Placement {
    switch (this.placementKind()) {
      case 'subfolder':
        return { kind: 'subfolder', name: this.subfolder().trim() };
      case 'folder':
        return { kind: 'folder', path: this.folder().trim().replace(/^\/+|\/+$/g, '') };
      case 'nextToNote':
        return { kind: 'nextToNote' };
      case 'vaultRoot':
        return { kind: 'vaultRoot' };
    }
  }

  private reset(): void {
    this.placementKind.set('subfolder');
    this.subfolder.set(MANAGED_DIR);
    this.folder.set('');
    this.removeUnused.set(false);
    this.dest.set(null);
    this.busy.set(false);
    this.error.set(null);
  }
}
