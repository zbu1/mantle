import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Sidebar } from './sidebar';
import { SidebarState } from './sidebar-state';

describe('Sidebar', () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    TestBed.configureTestingModule({
      imports: [Sidebar],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(Sidebar);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('reflects the collapsed state from SidebarState', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-sidebar-section')).toBeTruthy();

    state.toggleCollapsed();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-sidebar-section')).toBeFalsy();
  });

  function resizeHandle(fixture: ComponentFixture<Sidebar>): HTMLElement {
    return fixture.nativeElement.querySelector('[class*="cursor-col-resize"]');
  }

  // JSDOM has no PointerEvent constructor — build a MouseEvent and tack on
  // the pointer-specific fields the component reads (clientX, pointerId).
  function pointerEvent(type: string, clientX: number): Event {
    const event = new MouseEvent(type, { clientX });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return event;
  }

  it('collapses when the resize handle is dragged past the collapse threshold', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();
    const handle = resizeHandle(fixture);

    handle.dispatchEvent(pointerEvent('pointerdown', 500));
    handle.dispatchEvent(pointerEvent('pointermove', 100));

    expect(state.collapsed()).toBe(true);
  });

  it('does not collapse when dragged narrower but still above the collapse threshold', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();
    const handle = resizeHandle(fixture);

    handle.dispatchEvent(pointerEvent('pointerdown', 500));
    handle.dispatchEvent(pointerEvent('pointermove', 470));

    expect(state.collapsed()).toBe(false);
    expect(state.width()).toBe(210);
  });

  it('re-expands when the resize handle is dragged out from a collapsed state', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    state.setCollapsed(true);
    fixture.detectChanges();
    const handle = resizeHandle(fixture);

    handle.dispatchEvent(pointerEvent('pointerdown', 0));
    handle.dispatchEvent(pointerEvent('pointermove', 220));

    expect(state.collapsed()).toBe(false);
    expect(state.width()).toBe(220);
  });

  it('resets drag state when pointer capture is lost mid-drag', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();
    const handle = resizeHandle(fixture);

    handle.dispatchEvent(pointerEvent('pointerdown', 500));
    expect(state.resizing()).toBe(true);

    handle.dispatchEvent(new Event('lostpointercapture'));
    expect(state.resizing()).toBe(false);

    // A stray pointermove after capture loss should not resume the drag.
    handle.dispatchEvent(pointerEvent('pointermove', 100));
    expect(state.collapsed()).toBe(false);
  });

  it('resets drag state on window blur (mouse released outside the window)', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();
    const handle = resizeHandle(fixture);

    handle.dispatchEvent(pointerEvent('pointerdown', 500));
    expect(state.resizing()).toBe(true);

    // Neither pointerup nor lostpointercapture fires when the button is
    // released outside the OS window — only the window blur.
    window.dispatchEvent(new Event('blur'));
    expect(state.resizing()).toBe(false);

    // A fresh drag should work normally afterwards.
    handle.dispatchEvent(pointerEvent('pointerdown', 500));
    handle.dispatchEvent(pointerEvent('pointermove', 470));
    expect(state.width()).toBe(210);
  });
});
