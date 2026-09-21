import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Window } from './window';
import { WindowModel } from './window-model';
import { WindowStack } from './window-stack';

class TestModel extends WindowModel {
  open(): void {
    this.show();
  }
}

@Component({
  selector: 'app-window-host',
  imports: [Window],
  template: `
    <app-window [windowId]="id" title="Test window" [state]="model" [width]="400" [height]="300"
      [minimizable]="minimizable()" [dimBackground]="dim()">
      @if (model.isOpen()) {
      <p class="body">Body</p>
      }
    </app-window>
  `,
})
class Host {
  id = 'test';
  model = new TestModel();
  minimizable = signal(true);
  dim = signal(false);
}

describe('WindowModel', () => {
  it('starts closed, restored and not maximized', () => {
    const model = new TestModel();
    expect(model.isOpen()).toBe(false);
    expect(model.minimized()).toBe(false);
    expect(model.maximized()).toBe(false);
  });

  it('show() restores a minimized window and bumps activation', () => {
    const model = new TestModel();
    model.open();
    model.minimize();
    const before = model.activation();
    model.open();
    expect(model.minimized()).toBe(false);
    expect(model.activation()).toBe(before + 1);
  });

  it('close() clears minimized but keeps maximized', () => {
    const model = new TestModel();
    model.open();
    model.minimize();
    model.toggleMaximized();
    model.close();
    expect(model.isOpen()).toBe(false);
    expect(model.minimized()).toBe(false);
    expect(model.maximized()).toBe(true);
  });
});

describe('WindowStack', () => {
  let stack: WindowStack;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    stack = TestBed.inject(WindowStack);
  });

  it('puts the most recently raised window in front', () => {
    stack.raise('a');
    stack.raise('b');
    expect(stack.zIndex('b')).toBeGreaterThan(stack.zIndex('a'));
    stack.raise('a');
    expect(stack.zIndex('a')).toBeGreaterThan(stack.zIndex('b'));
  });

  it('stays below the z-50 dialogs and menus', () => {
    stack.raise('a');
    stack.raise('b');
    expect(stack.zIndex('b')).toBeLessThan(50);
  });

  it('gives each minimized window its own dock slot, freeing it on undock', () => {
    stack.dock('a');
    stack.dock('b');
    expect(stack.dockSlot('a')).toBe(0);
    expect(stack.dockSlot('b')).toBe(1);
    stack.undock('a');
    expect(stack.dockSlot('b')).toBe(0);
  });
});

describe('Window', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let root: HTMLElement;

  const shell = () => root.querySelector<HTMLElement>('[role="dialog"]');
  const titlebar = () => root.querySelector<HTMLElement>('.frame') as HTMLElement;
  const button = (label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  // jsdom doesn't lay elements out, so give the shell a stable rect to drag from.
  function layoutShellAt(left: number, top: number): void {
    jest.spyOn(shell() as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      left,
      top,
      right: left + 400,
      bottom: top + 300,
      width: 400,
      height: 300,
      x: left,
      y: top,
      toJSON: () => {},
    } as DOMRect);
  }

  function pointer(target: HTMLElement, type: string, x: number, y: number): void {
    // jsdom has no PointerEvent; the handlers only read button/pointerId/clientX/clientY.
    target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideZonelessChangeDetection()] });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    root = fixture.nativeElement;
    await settle();
  });

  it('renders nothing while closed', () => {
    expect(shell()).toBeNull();
    expect(root.querySelector('.body')).toBeNull();
  });

  it('shows the title and content when opened, centered under the app title bar', async () => {
    host.model.open();
    await settle();
    expect(shell()?.getAttribute('aria-label')).toBe('Test window');
    expect(root.querySelector('h2')?.textContent).toContain('Test window');
    expect(root.querySelector('.body')).not.toBeNull();
    expect(shell()?.style.left).toBe('50%');
    expect(shell()?.style.top).toBe('calc(50% + 20px)');
  });

  it('moves the window when the title bar is dragged', async () => {
    host.model.open();
    await settle();
    layoutShellAt(100, 100);

    pointer(titlebar(), 'pointerdown', 150, 110);
    pointer(titlebar(), 'pointermove', 350, 210);
    await settle();

    // Grabbed 50px right / 10px down of the corner, so the corner follows the pointer.
    expect(shell()?.style.left).toBe('300px');
    expect(shell()?.style.top).toBe('200px');
  });

  it('stops following the pointer after it is released', async () => {
    host.model.open();
    await settle();
    layoutShellAt(100, 100);

    pointer(titlebar(), 'pointerdown', 150, 110);
    pointer(titlebar(), 'pointermove', 350, 210);
    pointer(titlebar(), 'pointerup', 350, 210);
    pointer(titlebar(), 'pointermove', 500, 400);
    await settle();

    expect(shell()?.style.left).toBe('300px');
  });

  it('does not start a drag from a title bar button', async () => {
    host.model.open();
    await settle();
    layoutShellAt(100, 100);

    pointer(button('Minimize') as HTMLElement, 'pointerdown', 150, 110);
    pointer(titlebar(), 'pointermove', 350, 210);
    await settle();

    expect(shell()?.style.left).toBe('50%');
  });

  it('keeps the title bar below the app header and on screen', async () => {
    host.model.open();
    await settle();
    layoutShellAt(100, 100);

    pointer(titlebar(), 'pointerdown', 100, 100);
    pointer(titlebar(), 'pointermove', -500, -500);
    await settle();
    expect(shell()?.style.top).toBe('40px');
    // At least 200px of the 400px-wide window stays visible on the left.
    expect(shell()?.style.left).toBe('-200px');

    pointer(titlebar(), 'pointermove', 99999, 99999);
    await settle();
    expect(shell()?.style.left).toBe(`${window.innerWidth - 200}px`);
    expect(shell()?.style.top).toBe(`${window.innerHeight - 40}px`);
  });

  it('maximizes below the app header and restores to where it was dragged', async () => {
    host.model.open();
    await settle();
    layoutShellAt(100, 100);
    pointer(titlebar(), 'pointerdown', 150, 110);
    pointer(titlebar(), 'pointermove', 350, 210);
    pointer(titlebar(), 'pointerup', 350, 210);
    await settle();

    button('Maximize')?.click();
    await settle();
    expect(shell()?.style.top).toBe('40px');
    expect(shell()?.style.left).toBe('0px');
    expect(shell()?.style.bottom).toBe('0px');
    expect(button('Restore Down')).not.toBeNull();

    button('Restore Down')?.click();
    await settle();
    expect(shell()?.style.left).toBe('300px');
    expect(shell()?.style.top).toBe('200px');
  });

  it('does not drag while maximized', async () => {
    host.model.open();
    host.model.toggleMaximized();
    await settle();
    layoutShellAt(0, 40);

    pointer(titlebar(), 'pointerdown', 50, 50);
    pointer(titlebar(), 'pointermove', 250, 250);
    await settle();

    expect(shell()?.style.left).toBe('0px');
  });

  it('double-clicking the title bar toggles maximize', async () => {
    host.model.open();
    await settle();

    titlebar().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(host.model.maximized()).toBe(true);

    titlebar().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(host.model.maximized()).toBe(false);
  });

  it('minimizes to a docked chip, keeps the body alive, and restores', async () => {
    host.model.open();
    await settle();

    button('Minimize')?.click();
    await settle();
    expect(shell()?.style.right).toBe('12px');
    expect(shell()?.style.bottom).toBe('12px');
    expect(root.querySelector<HTMLElement>('.body')?.parentElement?.style.display).toBe('none');
    expect(button('Minimize')).toBeNull();

    button('Restore')?.click();
    await settle();
    expect(host.model.minimized()).toBe(false);
    expect(root.querySelector<HTMLElement>('.body')?.parentElement?.style.display).toBe('');
  });

  it('clicking a minimized chip restores it', async () => {
    host.model.open();
    host.model.minimize();
    await settle();

    root.querySelector<HTMLElement>('h2')?.click();
    await settle();
    expect(host.model.minimized()).toBe(false);
  });

  it('dims the app behind it only when asked to', async () => {
    const scrim = () => root.querySelector('[data-scrim]');
    host.model.open();
    await settle();
    expect(scrim()).toBeNull();

    host.dim.set(true);
    await settle();
    expect(scrim()).not.toBeNull();

    host.model.close();
    await settle();
    expect(scrim()).toBeNull();
  });

  it('omits the minimize button when not minimizable', async () => {
    host.minimizable.set(false);
    host.model.open();
    await settle();

    expect(button('Minimize')).toBeNull();
    expect(button('Maximize')).not.toBeNull();
    expect(button('Close')).not.toBeNull();
  });

  describe('resizing', () => {
    const handle = (edge: string) => root.querySelector<HTMLElement>(`[data-edge="${edge}"]`) as HTMLElement;

    beforeEach(async () => {
      host.model.open();
      await settle();
      layoutShellAt(100, 100);
    });

    it('grows from the bottom-right corner, leaving the top-left where it was', async () => {
      pointer(handle('se'), 'pointerdown', 500, 400);
      pointer(handle('se'), 'pointermove', 620, 450);
      await settle();

      expect(shell()?.style.left).toBe('100px');
      expect(shell()?.style.top).toBe('100px');
      expect(shell()?.style.width).toBe('520px');
      expect(shell()?.style.height).toBe('350px');
    });

    it('grows from the left edge, keeping the right edge fixed', async () => {
      pointer(handle('w'), 'pointerdown', 100, 250);
      pointer(handle('w'), 'pointermove', 0, 250);
      await settle();

      expect(shell()?.style.left).toBe('0px');
      expect(shell()?.style.width).toBe('500px');
      expect(shell()?.style.height).toBe('300px');
    });

    it('stops shrinking at the minimum size, keeping the opposite edge fixed', async () => {
      const nw = handle('nw');
      pointer(nw, 'pointerdown', 100, 100);
      pointer(nw, 'pointermove', 400, 300);
      await settle();

      expect(shell()?.style.width).toBe('480px');
      expect(shell()?.style.height).toBe('320px');
      // Right edge (500) and bottom edge (400) stay put.
      expect(shell()?.style.left).toBe('20px');
      expect(shell()?.style.top).toBe('80px');
    });

    it('cannot be resized up under the app title bar', async () => {
      const n = handle('n');
      pointer(n, 'pointerdown', 300, 100);
      pointer(n, 'pointermove', 300, -500);
      await settle();

      expect(shell()?.style.top).toBe('40px');
    });

    it('stops following the pointer once released', async () => {
      const e = handle('e');
      pointer(e, 'pointerdown', 500, 250);
      pointer(e, 'pointermove', 600, 250);
      pointer(e, 'pointerup', 600, 250);
      pointer(e, 'pointermove', 700, 250);
      await settle();

      expect(shell()?.style.width).toBe('500px');
    });

    it('reopens at the size it was resized to', async () => {
      const e = handle('e');
      pointer(e, 'pointerdown', 500, 250);
      pointer(e, 'pointermove', 600, 250);
      pointer(e, 'pointerup', 600, 250);
      host.model.close();
      await settle();

      host.model.open();
      await settle();
      expect(shell()?.style.width).toBe('500px');
    });

    it('has no resize handles while maximized', async () => {
      host.model.toggleMaximized();
      await settle();

      expect(root.querySelector('[data-edge]')).toBeNull();
    });
  });

  it('closes from the close button and on Escape', async () => {
    host.model.open();
    await settle();
    button('Close')?.click();
    await settle();
    expect(host.model.isOpen()).toBe(false);

    host.model.open();
    await settle();
    shell()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(host.model.isOpen()).toBe(false);
  });

  it('reopens where it was dragged to', async () => {
    host.model.open();
    await settle();
    layoutShellAt(100, 100);
    pointer(titlebar(), 'pointerdown', 150, 110);
    pointer(titlebar(), 'pointermove', 350, 210);
    pointer(titlebar(), 'pointerup', 350, 210);
    host.model.close();
    await settle();

    host.model.open();
    await settle();
    expect(shell()?.style.left).toBe('300px');
  });
});
