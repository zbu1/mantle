import { Component, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import { join } from '@tauri-apps/api/path';
import { LucideFileInput, LucideFileText, LucideLock, LucideLockOpen } from '@lucide/angular';
import { MenuItem } from '../../shared/menu/menu-item';
import { MenuSeparator } from '../../shared/menu/menu-separator';
import { MenuSurface } from '../../shared/menu/menu-surface';
import { ContextMenuAction, ContextMenuFlatItem } from '../../shared/context-menu/context-menu.model';
import { CredentialProfile, CredentialsState } from '../credentials-state';
import { NoteEncryptionActions } from '../note-encryption-actions';
import { VaultNoteNode, markdownExtensionOf } from '../vault-tree.model';
import { VaultState } from '../vault-state';
import { EncryptionPanelState } from './encryption-panel-state';

// Matches the w-72 that `wide` puts on MenuSurface.
const PANEL_WIDTH = 288;
const PANEL_GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * The editor toolbar's encryption panel: opened from the document icon, it
 * shows the active note's encryption status and file info above the same
 * encrypt/decrypt/move/lock actions as the sidebar's note context menu.
 *
 * Unlike `ContextMenu`, this is anchored under a fixed button rather than the
 * mouse position, so it's its own component with its own positioning and
 * keyboard handling rather than an extra case bolted onto that one.
 */
@Component({
  selector: 'app-encryption-panel',
  imports: [MenuSurface, MenuItem, MenuSeparator, LucideFileInput, LucideFileText, LucideLock, LucideLockOpen],
  templateUrl: './encryption-panel.html',
})
export class EncryptionPanel {
  private readonly state = inject(EncryptionPanelState);
  private readonly credentialsState = inject(CredentialsState);
  private readonly encryptionActions = inject(NoteEncryptionActions);
  private readonly vaultState = inject(VaultState);

  protected readonly note = computed<VaultNoteNode | null>(() => this.state.target()?.note ?? null);

  protected readonly statusIcon = computed<'locked' | 'unlocked' | 'plain'>(() => {
    const note = this.note();
    if (!note || !note.encrypted) return 'plain';
    return this.credentialsState.isUnlocked(note.profile) ? 'unlocked' : 'locked';
  });

  protected readonly statusTitle = computed(() => {
    switch (this.statusIcon()) {
      case 'plain':
        return 'Not encrypted';
      case 'locked':
        return 'Locked';
      case 'unlocked':
        return 'Encrypted';
    }
  });

  protected readonly statusSubtitle = computed(() => {
    const note = this.note();
    if (!note) return '';
    if (!note.encrypted) {
      return markdownExtensionOf(note.relPath) ? 'Plain Markdown file on disk' : 'Stored as plaintext on disk';
    }

    const name = this.credentialsState.displayNameOf(note.profile);
    if (this.statusIcon() === 'unlocked') return `Unlocked with "${name}"`;

    const known = note.profile !== null && this.credentialsState.profileById(note.profile);
    return known ? `Encrypted with "${name}"` : `Encrypted with "${name}" (not in this vault)`;
  });

  protected readonly fileName = computed(() => this.note()?.relPath.split('/').pop() ?? '');

  /**
   * The note's containing folder as a full filesystem path (vault root +
   * relPath's directory), not just the vault-relative folder — resolved
   * through Tauri's `join` (same as `VaultState.revealInFileExplorer`) so it
   * comes out with the OS's native separator.
   */
  protected readonly fileLocation = signal('');
  private readonly updateFileLocation = effect(() => {
    const note = this.note();
    const root = this.vaultState.rootPath();
    if (!note || !root) {
      this.fileLocation.set('');
      return;
    }

    const segments = note.relPath.split('/');
    segments.pop();
    void join(root, ...segments).then((path) => this.fileLocation.set(path));
  });

  protected readonly fileFormat = computed(() => {
    const note = this.note();
    const markdownExt = note ? markdownExtensionOf(note.relPath) : null;
    if (markdownExt) return `Markdown (${markdownExt})`;
    return note?.encrypted ? 'Encrypted (.mntl.enc)' : 'Plaintext (.mntl)';
  });

  /** Which of the file-info rows most recently showed "Copied!", or null once that's worn off. */
  protected readonly copiedField = signal<'file' | 'location' | null>(null);
  private copiedFieldTimer: ReturnType<typeof setTimeout> | null = null;

  /** Copies `value` (the File or Location row) and flashes "Copied!" in its place briefly. */
  protected copy(field: 'file' | 'location', value: string): void {
    if (!value) return;
    void navigator.clipboard?.writeText(value);

    if (this.copiedFieldTimer !== null) clearTimeout(this.copiedFieldTimer);
    this.copiedField.set(field);
    this.copiedFieldTimer = setTimeout(() => {
      this.copiedField.set(null);
      this.copiedFieldTimer = null;
    }, 1200);
  }

  /**
   * Other profiles this encrypted, unlocked note could move to — offered here
   * through the `<select>` in the template rather than the sidebar menu's flat
   * "Move to X" row per profile, since a picker reads better once there's
   * already a status header and file info above it.
   */
  protected readonly otherProfiles = computed<CredentialProfile[]>(() => {
    const note = this.note();
    if (!note || !note.encrypted || !this.credentialsState.isUnlocked(note.profile)) return [];
    return this.credentialsState.profiles().filter((p) => p.id !== note.profile);
  });

  protected readonly canMove = computed(() => this.otherProfiles().length > 0);

  /**
   * The same actions as the sidebar's note menu — including "Encrypt…", which
   * opens the encryption modal — minus the flat "Move to X" rows (replaced by
   * the `otherProfiles` picker) and plus a "Lock" entry the toolbar button
   * alone offers.
   */
  protected readonly items = computed<ContextMenuFlatItem[]>(() => {
    const note = this.note();
    if (!note) return [];

    if (note.encrypted && note.profile && this.credentialsState.isUnlocked(note.profile)) {
      const profileId = note.profile;
      return [
        { kind: 'item', label: 'Decrypt (make plaintext)', icon: 'unlock', action: () => void this.encryptionActions.decrypt(note) },
        { kind: 'separator' },
        {
          kind: 'item',
          label: `Lock profile "${this.credentialsState.displayNameOf(profileId)}"`,
          icon: 'lock',
          action: () => void this.credentialsState.lock(profileId),
        },
      ];
    }

    return this.encryptionActions.menuItems(note);
  });

  protected onMoveSelect(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const profileId = select.value;
    select.value = '';
    if (!profileId) return;

    const note = this.note();
    if (!note) return;
    void this.encryptionActions.moveToProfile(note, profileId);
    this.state.close();
  }

  // Mirrors ContextMenu's row highlighting: shared between hover and arrow
  // keys so only one row is ever highlighted, indexed into `items()` the same
  // way (separators occupy a slot but are never selectable).
  protected readonly selectedIndex = signal<number | null>(null);
  private readonly resetOnTargetChange = effect(() => {
    this.state.target();
    this.selectedIndex.set(null);
    this.copiedField.set(null);
  });

  private readonly actionIndices = computed(() =>
    this.items().reduce<number[]>((acc, item, i) => {
      if (item.kind === 'item' && !item.disabled) acc.push(i);
      return acc;
    }, []),
  );

  // #panel is an <app-menu-surface>, so read its host element rather than the
  // component instance — the pointerdown guard below needs to hit-test the DOM.
  protected readonly panel = viewChild('panel', { read: ElementRef<HTMLElement> });

  protected readonly style = computed(() => {
    const target = this.state.target();
    if (!target) return {};

    const rect = target.anchor.getBoundingClientRect();
    const fitsRight = rect.left + PANEL_WIDTH + VIEWPORT_MARGIN <= window.innerWidth;
    const left = fitsRight ? rect.left : rect.right - PANEL_WIDTH;
    const top = rect.bottom + PANEL_GAP;

    return {
      left: `${Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN))}px`,
      top: `${top}px`,
      // Clamped rather than flipped above the button: the toolbar sits at the
      // top of the content pane, so there's normally room below, and a
      // variable-height panel (status + file info + however many profiles)
      // can't precompute its height the way ContextMenu does.
      'max-height': `${Math.max(160, window.innerHeight - top - VIEWPORT_MARGIN)}px`,
    };
  });

  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    const panel = this.panel()?.nativeElement;
    if (panel && event.target instanceof Node && panel.contains(event.target)) return;
    if (this.state.target()?.anchor === event.target) return;
    this.state.close();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.state.close();
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (!this.state.target()) return;
    // Let the native <select> (the move-to picker) handle its own
    // arrow/Enter keys instead of hijacking them for the action list.
    if (event.target instanceof HTMLSelectElement) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveSelection(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveSelection(-1);
      return;
    }

    if (event.key === 'Enter') {
      const index = this.selectedIndex();
      const item = index === null ? undefined : this.items()[index];
      if (item?.kind !== 'item') return;
      event.preventDefault();
      this.select(item);
    }
  }

  @HostListener('window:blur')
  protected onBlur(): void {
    this.state.close();
  }

  private moveSelection(delta: number): void {
    const indices = this.actionIndices();
    if (indices.length === 0) return;

    const current = this.selectedIndex();
    if (current === null) {
      this.selectedIndex.set(delta > 0 ? indices[0] : indices[indices.length - 1]);
      return;
    }

    const currentPos = indices.indexOf(current);
    const nextPos = (currentPos + delta + indices.length) % indices.length;
    this.selectedIndex.set(indices[nextPos]);
  }

  protected select(item: ContextMenuAction): void {
    item.action();
    this.state.close();
  }
}
