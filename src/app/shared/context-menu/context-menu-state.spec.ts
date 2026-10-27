import { withoutDesktopOnly } from './context-menu-state';
import { ContextMenuItem } from './context-menu.model';

describe('withoutDesktopOnly', () => {
  const item = (label: string, desktopOnly = false): ContextMenuItem => ({ kind: 'item', label, desktopOnly, action: () => {} });
  const sep: ContextMenuItem = { kind: 'separator' };
  const labels = (items: ContextMenuItem[]) => items.map((i) => (i.kind === 'separator' ? '-' : i.label));

  it('drops desktop-only items and the separators left doubled or at an end', () => {
    const items = [item('Reveal', true), sep, item('Open'), sep, item('Split', true), sep, item('Rename'), sep, item('Reveal', true)];
    expect(labels(withoutDesktopOnly(items))).toEqual(['Open', '-', 'Rename']);
  });
});
