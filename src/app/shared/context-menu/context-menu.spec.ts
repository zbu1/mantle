import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ContextMenu } from './context-menu';
import { ContextMenuState } from './context-menu-state';
import { ContextMenuItem } from './context-menu.model';

function rightClick(): MouseEvent {
  return new MouseEvent('contextmenu', { clientX: 40, clientY: 60, bubbles: true, cancelable: true });
}

// jsdom has no PointerEvent constructor; the listener only reads event.target,
// so a MouseEvent of the same type exercises the same path.
function pointerDown(): MouseEvent {
  return new MouseEvent('pointerdown', { bubbles: true });
}

describe('ContextMenu', () => {
  let state: ContextMenuState;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ContextMenu],
      providers: [provideZonelessChangeDetection()],
    });
    state = TestBed.inject(ContextMenuState);
  });

  it('renders nothing until a menu is opened', () => {
    const fixture = TestBed.createComponent(ContextMenu);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-menu-surface')).toBeNull();
  });

  it('renders items and separators through the shared menu components', () => {
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Open', icon: 'open', action: () => {} },
      { kind: 'separator' },
      { kind: 'item', label: 'Delete', icon: 'delete', danger: true, action: () => {} },
    ];
    const fixture = TestBed.createComponent(ContextMenu);
    state.open(rightClick(), items);
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('app-menu-surface')).toBeTruthy();
    expect(el.querySelectorAll('app-menu-separator').length).toBe(1);

    const rows = Array.from(el.querySelectorAll('app-menu-item'));
    expect(rows.map((row) => row.textContent?.trim())).toEqual(['Open', 'Delete']);
    // Each row carries its icon, projected into the shared item's leading slot.
    expect(rows.every((row) => row.querySelector('svg'))).toBe(true);
  });

  it('styles danger items destructively', () => {
    const items: ContextMenuItem[] = [
      { kind: 'item', label: 'Open', icon: 'open', action: () => {} },
      { kind: 'item', label: 'Delete', icon: 'delete', danger: true, action: () => {} },
    ];
    const fixture = TestBed.createComponent(ContextMenu);
    state.open(rightClick(), items);
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('app-menu-item button');
    expect(buttons[0].className).not.toContain('text-destructive');
    expect(buttons[1].className).toContain('text-destructive');
  });

  it('runs the action and closes when an item is clicked', () => {
    const action = jest.fn();
    const fixture = TestBed.createComponent(ContextMenu);
    state.open(rightClick(), [{ kind: 'item', label: 'Open', icon: 'open', action }]);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('app-menu-item button').click();
    fixture.detectChanges();

    expect(action).toHaveBeenCalledTimes(1);
    expect(state.menu()).toBeNull();
    expect(fixture.nativeElement.querySelector('app-menu-surface')).toBeNull();
  });

  it('keeps the menu open when the click lands inside the panel', () => {
    const fixture = TestBed.createComponent(ContextMenu);
    state.open(rightClick(), [{ kind: 'item', label: 'Open', icon: 'open', action: () => {} }]);
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('app-menu-surface');
    panel.dispatchEvent(pointerDown());
    fixture.detectChanges();

    expect(state.menu()).not.toBeNull();
  });

  it('closes on a pointerdown outside the panel', () => {
    const fixture = TestBed.createComponent(ContextMenu);
    state.open(rightClick(), [{ kind: 'item', label: 'Open', icon: 'open', action: () => {} }]);
    fixture.detectChanges();

    document.body.dispatchEvent(pointerDown());
    fixture.detectChanges();

    expect(state.menu()).toBeNull();
  });

  it('suppresses the native menu in areas that have no custom menu wired up', () => {
    const fixture = TestBed.createComponent(ContextMenu);
    fixture.detectChanges();

    const event = rightClick();
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
