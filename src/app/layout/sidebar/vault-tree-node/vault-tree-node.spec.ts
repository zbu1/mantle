import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { VaultNoteNode } from '../../../notes/vault-tree.model';
import { VaultTreeNode } from './vault-tree-node';

function note(overrides: Partial<VaultNoteNode> = {}): VaultNoteNode {
  return {
    type: 'note',
    name: 'dream',
    relPath: 'dream.mntl.enc',
    encrypted: true,
    profile: 'my-diary',
    ...overrides,
  };
}

describe('VaultTreeNode', () => {
  let fixture: ComponentFixture<VaultTreeNode>;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [VaultTreeNode],
      providers: [provideZonelessChangeDetection()],
    });
    fixture = TestBed.createComponent(VaultTreeNode);
  });

  function render(node: VaultNoteNode, unlocked: string[] = []): void {
    fixture.componentRef.setInput('node', node);
    fixture.componentRef.setInput('unlockedProfiles', new Set(unlocked));
    fixture.detectChanges();
  }

  function clickNote(): void {
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
  }

  it('emits lockedClicked for an encrypted note whose profile is locked', () => {
    const locked = jest.fn();
    const opened = jest.fn();
    render(note());
    fixture.componentInstance.lockedClicked.subscribe(locked);
    fixture.componentInstance.openNote.subscribe(opened);

    clickNote();

    // The whole node is emitted, not just its path, so the handler knows which
    // profile to unlock.
    expect(locked).toHaveBeenCalledWith(expect.objectContaining({ profile: 'my-diary' }));
    expect(opened).not.toHaveBeenCalled();
  });

  it('opens an encrypted note normally once its profile is unlocked', () => {
    const locked = jest.fn();
    const opened = jest.fn();
    render(note(), ['my-diary']);
    fixture.componentInstance.lockedClicked.subscribe(locked);
    fixture.componentInstance.openNote.subscribe(opened);

    clickNote();

    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'dream.mntl.enc' }));
    expect(locked).not.toHaveBeenCalled();
  });

  it('treats an encrypted note with an unreadable header as locked', () => {
    const locked = jest.fn();
    render(note({ profile: null }), ['my-diary']);
    fixture.componentInstance.lockedClicked.subscribe(locked);

    clickNote();

    expect(locked).toHaveBeenCalled();
  });

  it('opens a plaintext note regardless of which profiles are unlocked', () => {
    const opened = jest.fn();
    render(note({ relPath: 'todo.mntl', encrypted: false, profile: null }));
    fixture.componentInstance.openNote.subscribe(opened);

    clickNote();

    expect(opened).toHaveBeenCalled();
  });

  it('keeps encrypted notes draggable while locked', () => {
    // Moving or renaming a note is a plain filesystem rename that never reads
    // its contents, so there's no reason a locked note can't be reorganized.
    render(note());
    const wrapper = fixture.nativeElement.querySelector('[data-tree-path]') as HTMLElement;
    expect(wrapper.getAttribute('draggable')).toBe('true');
  });
});
