import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { VaultRootState } from '../../notes/vault-root-state';
import { VaultState } from '../../notes/vault-state';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { DialogState } from '../../shared/dialog/dialog-state';
import { Welcome } from './welcome';

describe('Welcome', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [Welcome],
      providers: [provideZonelessChangeDetection()],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(Welcome);
    fixture.detectChanges();
    return fixture;
  }

  it('offers creating and opening a vault', () => {
    const el: HTMLElement = render().nativeElement;
    expect(el.querySelector('[data-welcome-create]')?.textContent).toContain('Create a new vault');
    expect(el.querySelector('[data-welcome-open]')?.textContent).toContain('Open a folder');
  });

  it('runs the matching VaultState action for each button', async () => {
    const vaultState = TestBed.inject(VaultState);
    const create = jest.spyOn(vaultState, 'createVault').mockResolvedValue();
    const pick = jest.spyOn(vaultState, 'pickVault').mockResolvedValue();
    const el: HTMLElement = render().nativeElement;

    el.querySelector<HTMLButtonElement>('[data-welcome-create]')!.click();
    await Promise.resolve();
    el.querySelector<HTMLButtonElement>('[data-welcome-open]')!.click();

    expect(create).toHaveBeenCalledTimes(1);
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('ignores a second action while a dialog from the first is still open', () => {
    const vaultState = TestBed.inject(VaultState);
    const create = jest.spyOn(vaultState, 'createVault').mockReturnValue(new Promise(() => {}));
    const pick = jest.spyOn(vaultState, 'pickVault').mockResolvedValue();
    const el: HTMLElement = render().nativeElement;

    el.querySelector<HTMLButtonElement>('[data-welcome-create]')!.click();
    el.querySelector<HTMLButtonElement>('[data-welcome-open]')!.click();

    expect(create).toHaveBeenCalledTimes(1);
    expect(pick).not.toHaveBeenCalled();
  });

  it('lists recent vaults, numbered, and opens one by its number key', () => {
    TestBed.inject(VaultRootState).recents.set(['/home/me/Journal', '/home/me/Work']);
    const switchVault = jest.spyOn(TestBed.inject(VaultState), 'switchVault').mockResolvedValue();
    const el: HTMLElement = render().nativeElement;

    const items = el.querySelectorAll('[data-welcome-recent] li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('01');
    expect(items[0].textContent).toContain('Journal');

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    expect(switchVault).toHaveBeenCalledWith('/home/me/Work');
  });

  it('ignores shortcut keys typed into a field outside the screen', () => {
    const create = jest.spyOn(TestBed.inject(VaultState), 'createVault').mockResolvedValue();
    render();
    const input = document.createElement('input');
    document.body.appendChild(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));

    expect(create).not.toHaveBeenCalled();
    input.remove();
  });

  it('removes a vault from recents through its menu', () => {
    TestBed.inject(VaultRootState).recents.set(['/home/me/Journal', '/home/me/Work']);
    const fixture = render();
    fixture.nativeElement.querySelector('[data-welcome-vault-menu]').click();
    const items = TestBed.inject(ContextMenuState).menu()!.items;
    const remove = items.find((item) => item.kind === 'item' && item.label === 'Remove from Recents');
    if (remove?.kind === 'item') remove.action();
    expect(TestBed.inject(VaultState).recentVaults()).toEqual(['/home/me/Work']);
  });

  it('clears recents only once confirmed', async () => {
    TestBed.inject(VaultRootState).recents.set(['/home/me/Journal']);
    const confirm = jest.spyOn(TestBed.inject(DialogState), 'confirm').mockResolvedValueOnce(false);
    const fixture = render();
    const clear = () => fixture.nativeElement.querySelector('[data-welcome-clear]').click();

    clear();
    await Promise.resolve();
    expect(TestBed.inject(VaultState).recentVaults()).toHaveLength(1);

    confirm.mockResolvedValueOnce(true);
    clear();
    await Promise.resolve();
    expect(TestBed.inject(VaultState).recentVaults()).toEqual([]);
  });
});
