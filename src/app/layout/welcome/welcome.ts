import { Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { dirname, join } from '@tauri-apps/api/path';
import { save } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { LucideArrowLeft, LucideArrowRight, LucideEllipsis, LucideFolderInput, LucideFolderOpen, LucideFolderPlus } from '@lucide/angular';
import { CredentialsState } from '../../notes/credentials-state';
import { VaultState, vaultNameFromPath } from '../../notes/vault-state';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { DialogState } from '../../shared/dialog/dialog-state';
import { WindowControls } from '../window-controls/window-controls';

interface RecentVault {
  path: string;
  name: string;
  /** Two-digit position; its number key opens it. */
  index: string;
}

/** A path that sways between two nearby shapes: its `<animate>` morph values and timing. */
interface Sway {
  values: string;
  dur: string;
  begin: string;
}

interface StrataLayer {
  d: string;
  sway: Sway;
  stroke: string;
  width: number;
  delay: string;
}

const STRATA_WIDTH = 1200;
const STRATA_HEIGHT = 400;
const STRATA_COUNT = 13;

/**
 * One contour line of the strata backdrop: a gentle wave across the full
 * width. Amplitude grows and wavelength shortens with depth, so the lines
 * read as rock layers buckling toward something hot underneath. Deterministic
 * — the same layer and `drift` always give the same shape; `drift` shifts the
 * wave's phase, which is what the sway animates.
 */
function strataPath(layer: number, drift = 0): string {
  const t = layer / (STRATA_COUNT - 1);
  const baseY = 30 + t * (STRATA_HEIGHT - 50);
  const amplitude = 6 + t * 22;
  const waves = 1.4 + t * 1.2;
  const phase = layer * 0.9 + drift;
  const steps = 48;
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const y =
      baseY +
      Math.sin(u * Math.PI * 2 * waves + phase) * amplitude +
      Math.sin(u * Math.PI * 5.3 + phase * 1.7) * amplitude * 0.25;
    points.push([u * STRATA_WIDTH, y]);
  }
  return smoothPath(points);
}

/**
 * A Catmull-Rom spline through `points`, as cubic Béziers. Straight segments
 * between samples show visible corners once the SVG is stretched across a
 * wide window (`preserveAspectRatio="none"`); this keeps every joint smooth.
 */
function smoothPath(points: [number, number][]): string {
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[Math.max(i - 1, 0)];
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const [x3, y3] = points[Math.min(i + 2, points.length - 1)];
    const c1x = x1 + (x2 - x0) / 6;
    const c1y = y1 + (y2 - y0) / 6;
    const c2x = x2 - (x3 - x1) / 6;
    const c2y = y2 - (y3 - y1) / 6;
    d += ` C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(x2)} ${f(y2)}`;
  }
  return d;
}

/**
 * A slow back-and-forth between the layer's shape at `-reach` and `+reach`
 * phase drift. Deeper layers reach further, as if pushed from below, and each
 * layer gets its own period and a negative start offset so they sway out of
 * step from the first frame instead of all starting together. Both ends of a
 * layer share one command structure, so SMIL can interpolate between them.
 */
function sway(layer: number, toPath: (drift: number) => string): Sway {
  const t = layer / (STRATA_COUNT - 1);
  const reach = 0.18 + t * 0.32;
  const period = 11 + ((layer * 7) % 9);
  const from = toPath(-reach);
  return {
    values: `${from};${toPath(reach)};${from}`,
    dur: `${period}s`,
    begin: `-${((layer * 3.7) % period).toFixed(1)}s`,
  };
}

function glowPath(drift: number): string {
  return `${strataPath(STRATA_COUNT - 1, drift)} L${STRATA_WIDTH} ${STRATA_HEIGHT} L0 ${STRATA_HEIGHT} Z`;
}

/** Layers warm from the border tone at the top to full ember at the bottom, and settle in bottom-up. */
const STRATA: StrataLayer[] = Array.from({ length: STRATA_COUNT }, (_, layer) => {
  const t = layer / (STRATA_COUNT - 1);
  const ember = Math.round(Math.pow(t, 1.8) * 100);
  return {
    d: strataPath(layer),
    sway: sway(layer, (drift) => strataPath(layer, drift)),
    stroke: `color-mix(in oklab, var(--primary) ${ember}%, var(--border))`,
    width: 1 + t * 0.75,
    delay: `${(STRATA_COUNT - layer) * 45}ms`,
  };
});

/**
 * Fullscreen landing shown in place of the whole workspace (header, sidebar
 * and editor) while no vault is open: create a vault, open a folder, or jump
 * back into a recent one. `N`, `O` and `1`–`8` do the same from the keyboard.
 * Also shown over an open vault as "Manage Vaults" (`VaultState.managing`),
 * where `Esc` goes back to the vault.
 */
@Component({
  selector: 'app-welcome',
  imports: [WindowControls, LucideFolderPlus, LucideFolderOpen, LucideFolderInput, LucideArrowRight, LucideArrowLeft, LucideEllipsis],
  templateUrl: './welcome.html',
  host: { class: 'relative flex min-h-0 flex-1 flex-col overflow-hidden' },
})
export class Welcome {
  protected readonly vaultState = inject(VaultState);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly credentials = inject(CredentialsState);
  private readonly contextMenu = inject(ContextMenuState);
  private readonly dialog = inject(DialogState);

  protected readonly strata = STRATA;
  protected readonly strataViewBox = `0 0 ${STRATA_WIDTH} ${STRATA_HEIGHT}`;
  protected readonly glowPath = glowPath(0);
  /** The glow rides on the bottom layer, so it sways in step with it. */
  protected readonly glowSway = sway(STRATA_COUNT - 1, glowPath);
  // SMIL animations ignore the CSS reduced-motion media query, so check it here.
  protected readonly animate = !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /** True while a native dialog from this screen is up, so a double press doesn't stack a second one. */
  protected readonly busy = signal(false);
  protected readonly importing = signal(false);

  /** Path of the recent vault whose name is being edited inline, if any. */
  protected readonly renaming = signal<string | null>(null);

  protected readonly recentVaults = computed<RecentVault[]>(() =>
    this.vaultState.recentVaults().map((path, i) => ({
      path,
      name: vaultNameFromPath(path),
      index: String(i + 1).padStart(2, '0'),
    })),
  );

  protected createVault(): Promise<void> {
    return this.run(() => this.vaultState.createVault());
  }

  protected openVault(): Promise<void> {
    return this.run(() => this.vaultState.pickVault());
  }

  /** Imports an Obsidian vault into a new Mantle vault, then says what didn't convert. */
  protected importVault(): Promise<void> {
    return this.run(async () => {
      this.importing.set(true);
      const report = await this.vaultState.importObsidianVault().finally(() => this.importing.set(false));
      if (!report || report.failed.length === 0) return;
      await this.dialog.alert(
        `${report.notes} notes imported. These Markdown files couldn't be converted and were copied as they are:\n\n` +
          report.failed.map((f) => `${f.relPath}: ${f.error}`).join('\n'),
        { title: 'Some Files Not Converted', tone: 'warning' },
      );
    });
  }

  protected openRecent(path: string): Promise<void> {
    // Picking the vault that's already open just goes back to it.
    this.vaultState.managing.set(false);
    return this.vaultState.switchVault(path);
  }

  protected openMenu(event: MouseEvent, path: string): void {
    this.contextMenu.open(event, [
      { kind: 'item', label: 'Reveal in File Explorer', icon: 'reveal', action: () => void revealItemInDir(path) },
      { kind: 'item', label: 'Rename', icon: 'rename', action: () => this.startRename(path) },
      { kind: 'item', label: 'Move…', icon: 'move-to-root', action: () => void this.moveVault(path) },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Remove from Recents',
        icon: 'delete',
        danger: true,
        action: () => this.vaultState.removeRecentVault(path),
      },
    ]);
  }

  private startRename(path: string): void {
    this.renaming.set(path);
    // `autofocus` only applies on page load, so focus the input once it renders.
    setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>('[data-welcome-rename]')?.focus());
  }

  /** Commits an inline rename. Enter and blur both land here, so it only runs once per edit. */
  protected async commitRename(path: string, name: string): Promise<void> {
    if (this.renaming() !== path) return;
    this.renaming.set(null);
    name = name.trim();
    if (!name || name === vaultNameFromPath(path)) return;
    await this.run(async () => {
      await this.move(path, await join(await dirname(path), name));
    });
  }

  private moveVault(path: string): Promise<void> {
    return this.run(async () => {
      const to = await save({ title: 'Move Vault', defaultPath: path });
      if (to) await this.move(path, to);
    });
  }

  private async move(from: string, to: string): Promise<void> {
    // Unlocked keys are tied to the vault's path, and pending saves need them.
    if (from === this.vaultState.rootPath()) await this.credentials.lockAll();
    await this.vaultState.moveVault(from, to);
  }

  protected async clearRecents(): Promise<void> {
    const confirmed = await this.dialog.confirm('The vault folders stay on disk; only this list is cleared.', {
      title: 'Clear recent vaults?',
      tone: 'warning',
      confirmLabel: 'Clear',
    });
    if (confirmed) this.vaultState.clearRecentVaults();
  }

  protected back(): void {
    this.vaultState.managing.set(false);
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
    } finally {
      this.busy.set(false);
    }
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    // Only when focus is on this screen (or nowhere) — never while typing in,
    // say, the command palette or a settings field layered on top of it.
    const target = event.target;
    if (target !== document.body && !(target instanceof Node && this.host.nativeElement.contains(target))) return;
    if (target instanceof HTMLInputElement) return;

    const key = event.key.toLowerCase();
    if (key === 'escape' && this.vaultState.managing()) {
      event.preventDefault();
      this.back();
    } else if (key === 'n') {
      event.preventDefault();
      void this.createVault();
    } else if (key === 'o') {
      event.preventDefault();
      void this.openVault();
    } else if (/^[1-9]$/.test(key)) {
      const recent = this.recentVaults()[Number(key) - 1];
      if (!recent) return;
      event.preventDefault();
      void this.openRecent(recent.path);
    }
  }
}
