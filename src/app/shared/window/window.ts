import { Component, ElementRef, HostListener, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { LucideMaximize, LucideMinimize, LucideMinus, LucideX } from '@lucide/angular';
import { WindowModel } from './window-model';
import { WindowStack } from './window-stack';
import { isMobile } from '../../core/tauri-env';

/** Height of the app's own title bar (`h-10` in header.html) — a window never covers it, so its controls stay reachable. */
const APP_HEADER_HEIGHT = 40;
/** Height of a window's title bar (`h-10`) — also the height of a minimized window's dock chip. */
const TITLEBAR_HEIGHT = 40;
/** How much of a dragged window must stay on screen, measured from whichever side is nearest the edge. */
const MIN_VISIBLE_WIDTH = 200;
const VIEWPORT_MARGIN = 16;
const DOCK_WIDTH = 260;
const DOCK_MARGIN = 12;
const DOCK_GAP = 8;
/** Smallest a window can be resized to — enough for the settings nav beside a usable pane. */
const MIN_WIDTH = 480;
const MIN_HEIGHT = 320;

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface ResizeHandle {
  edge: ResizeEdge;
  class: string;
}

const RESIZE_HANDLES: readonly ResizeHandle[] = [
  { edge: 'n', class: 'inset-x-2 top-0 h-1 cursor-ns-resize' },
  { edge: 's', class: 'inset-x-2 bottom-0 h-1 cursor-ns-resize' },
  { edge: 'w', class: 'inset-y-2 left-0 w-1 cursor-ew-resize' },
  { edge: 'e', class: 'inset-y-2 right-0 w-1 cursor-ew-resize' },
  { edge: 'nw', class: 'left-0 top-0 size-2 cursor-nwse-resize' },
  { edge: 'ne', class: 'right-0 top-0 size-2 cursor-nesw-resize' },
  { edge: 'sw', class: 'bottom-0 left-0 size-2 cursor-nesw-resize' },
  { edge: 'se', class: 'bottom-0 right-0 size-2 cursor-nwse-resize' },
];

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

interface DragSession {
  pointerId: number;
  /** Where inside the window the pointer grabbed it, so the window doesn't jump. */
  grab: Point;
  width: number;
}

interface ResizeSession {
  pointerId: number;
  edge: ResizeEdge;
  /** Where the pointer was when the resize began. */
  origin: Point;
  /** The window's bounds when the resize began. */
  rect: Point & Size;
}

/**
 * A floating, non-modal window: draggable, resizable, minimizable to a chip
 * (unless `minimizable` is off), maximizable, closable with Escape.
 *
 * Open/minimized/maximized state lives in a `WindowModel`; position and size
 * live here and outlive closing. Project the body under your own
 * `@if (state.isOpen())` so it isn't kept alive while closed.
 */
@Component({
  selector: 'app-window',
  imports: [LucideMinus, LucideMaximize, LucideMinimize, LucideX],
  templateUrl: './window.html',
})
export class Window {
  private readonly stack = inject(WindowStack);

  /** Identifies this window to `WindowStack`. */
  readonly windowId = input.required<string>();
  readonly title = input.required<string>();
  readonly state = input.required<WindowModel>();
  /** Preferred size in px until the user resizes it; it shrinks to fit a small viewport. */
  readonly width = input(720);
  readonly height = input(560);
  /** Whether the title bar offers a minimize-to-dock button. */
  readonly minimizable = input(true);
  /** Darkens the rest of the app while the window is up. Purely visual — the app underneath stays clickable. */
  readonly dimBackground = input(false);

  /** Where the user dragged it to; `null` until the first drag, which leaves it centered. */
  private readonly position = signal<Point | null>(null);
  /** What the user resized it to; `null` until the first resize, which leaves it at the preferred size. */
  private readonly size = signal<Size | null>(null);
  private drag: DragSession | null = null;
  private resize: ResizeSession | null = null;

  protected readonly resizeHandles = RESIZE_HANDLES;

  private readonly shell = viewChild<ElementRef<HTMLElement>>('shell');
  private readonly focusSink = viewChild<ElementRef<HTMLElement>>('focusSink');

  protected readonly minimized = computed(() => this.state().minimized());
  // On Android every window fills the screen.
  protected readonly maximized = computed(() => isMobile || this.state().maximized());

  protected readonly frameClass = computed(() =>
    this.maximized() && !this.minimized()
      ? 'border-t border-border'
      : 'rounded-xl border border-border shadow-window',
  );

  protected readonly scrimZIndex = computed(() => this.stack.zIndex(this.windowId()));

  protected readonly frameStyle = computed((): Record<string, string> => {
    const id = this.windowId();
    const zIndex = String(this.stack.zIndex(id));

    if (this.minimized()) {
      const bottom = DOCK_MARGIN + this.stack.dockSlot(id) * (TITLEBAR_HEIGHT + DOCK_GAP);
      return { 'z-index': zIndex, right: `${DOCK_MARGIN}px`, bottom: `${bottom}px`, width: `${DOCK_WIDTH}px` };
    }
    if (this.maximized()) {
      return { 'z-index': zIndex, left: '0', right: '0', top: isMobile ? '0' : `${APP_HEADER_HEIGHT}px`, bottom: '0' };
    }

    const resized = this.size();
    const size: Record<string, string> = resized
      ? {
          width: `${resized.width}px`,
          height: `${resized.height}px`,
          'max-width': '100vw',
          'max-height': `calc(100vh - ${APP_HEADER_HEIGHT}px)`,
        }
      : {
          width: `min(${this.width()}px, calc(100vw - ${VIEWPORT_MARGIN}px))`,
          height: `min(${this.height()}px, calc(100vh - ${APP_HEADER_HEIGHT + VIEWPORT_MARGIN}px))`,
        };
    const position = this.position();
    if (position) return { 'z-index': zIndex, left: `${position.x}px`, top: `${position.y}px`, ...size };
    // Centered in the space below the app's title bar.
    return {
      'z-index': zIndex,
      left: '50%',
      top: `calc(50% + ${APP_HEADER_HEIGHT / 2}px)`,
      translate: '-50% -50%',
      ...size,
    };
  });

  constructor() {
    // Front and focus on every open (and on restore from minimized) — the sink
    // is a hidden focus target, since focusing the visible frame would trip the
    // global focus ring.
    effect(() => {
      const state = this.state();
      state.activation();
      if (!state.isOpen() || state.minimized()) return;
      this.stack.raise(this.windowId());
      this.focusSink()?.nativeElement.focus();
    });

    effect((onCleanup) => {
      const state = this.state();
      if (!state.isOpen() || !state.minimized()) return;
      const id = this.windowId();
      this.stack.dock(id);
      onCleanup(() => this.stack.undock(id));
    });
  }

  @HostListener('window:resize')
  protected onViewportResize(): void {
    const position = this.position();
    const rect = this.shell()?.nativeElement.getBoundingClientRect();
    if (position && rect) this.position.set(this.clamp(position, rect.width));
  }

  protected raise(): void {
    this.stack.raise(this.windowId());
  }

  protected onTitlebarPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.minimized() || this.maximized() || isControl(event.target)) return;
    const shell = this.shell()?.nativeElement;
    if (!shell) return;

    // Pin the window to pixel coordinates at wherever it currently is (which
    // may still be CSS-centered) so the drag continues from there.
    const rect = shell.getBoundingClientRect();
    this.position.set({ x: rect.left, y: rect.top });
    this.drag = {
      pointerId: event.pointerId,
      grab: { x: event.clientX - rect.left, y: event.clientY - rect.top },
      width: rect.width,
    };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  protected onTitlebarPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.position.set(this.clamp({ x: event.clientX - drag.grab.x, y: event.clientY - drag.grab.y }, drag.width));
  }

  protected onTitlebarPointerEnd(event: PointerEvent): void {
    if (this.drag && event.pointerId === this.drag.pointerId) this.drag = null;
  }

  protected onResizePointerDown(event: PointerEvent, edge: ResizeEdge): void {
    if (event.button !== 0 || this.minimized() || this.maximized()) return;
    const shell = this.shell()?.nativeElement;
    if (!shell) return;

    // Pin position and size to pixels at wherever the window currently is (which
    // may still be CSS-centered or CSS-clamped) so the resize continues from there.
    const rect = shell.getBoundingClientRect();
    this.position.set({ x: rect.left, y: rect.top });
    this.size.set({ width: rect.width, height: rect.height });
    this.resize = {
      pointerId: event.pointerId,
      edge,
      origin: { x: event.clientX, y: event.clientY },
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  protected onResizePointerMove(event: PointerEvent): void {
    const resize = this.resize;
    if (!resize || event.pointerId !== resize.pointerId) return;

    const { edge, rect } = resize;
    const dx = event.clientX - resize.origin.x;
    const dy = event.clientY - resize.origin.y;
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;

    // The edge opposite the one being dragged stays put; the window can't shrink
    // below its minimum or grow past the viewport / under the app's title bar.
    let x = rect.x;
    let y = rect.y;
    let width = rect.width;
    let height = rect.height;
    if (edge.includes('e')) width = clamp(rect.width + dx, MIN_WIDTH, window.innerWidth - rect.x);
    if (edge.includes('w')) {
      width = clamp(rect.width - dx, MIN_WIDTH, right);
      x = right - width;
    }
    if (edge.includes('s')) height = clamp(rect.height + dy, MIN_HEIGHT, window.innerHeight - rect.y);
    if (edge.includes('n')) {
      height = clamp(rect.height - dy, MIN_HEIGHT, bottom - APP_HEADER_HEIGHT);
      y = bottom - height;
    }

    this.position.set({ x, y });
    this.size.set({ width, height });
  }

  protected onResizePointerEnd(event: PointerEvent): void {
    if (this.resize && event.pointerId === this.resize.pointerId) this.resize = null;
  }

  protected onTitlebarDoubleClick(event: MouseEvent): void {
    if (isControl(event.target)) return;
    if (this.minimized()) this.state().restore();
    else this.state().toggleMaximized();
  }

  /** A minimized window is just a chip, so clicking it anywhere but the buttons brings it back. */
  protected onTitleClick(): void {
    if (this.minimized()) this.state().restore();
  }

  /**
   * Keeps enough of the window on screen to grab it back: the title bar never
   * goes above the app's own title bar or below the viewport, and at least
   * `MIN_VISIBLE_WIDTH` of it stays visible on the left or right.
   */
  private clamp(point: Point, width: number): Point {
    const minX = MIN_VISIBLE_WIDTH - width;
    const maxX = window.innerWidth - MIN_VISIBLE_WIDTH;
    const minY = APP_HEADER_HEIGHT;
    const maxY = window.innerHeight - TITLEBAR_HEIGHT;
    return {
      x: Math.min(Math.max(point.x, Math.min(minX, maxX)), maxX),
      y: Math.min(Math.max(point.y, minY), Math.max(minY, maxY)),
    };
  }
}

/** Like `Math.min(Math.max(value, min), max)`, but `min` wins when the range is inverted (a tiny viewport). */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button') !== null;
}
