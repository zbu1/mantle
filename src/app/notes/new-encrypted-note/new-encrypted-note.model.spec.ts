import { VaultFolderNode } from '../vault-tree.model';
import {
  encryptedNoteNamesIn,
  nextUntitledName,
  onDiskFileName,
  onDiskRelPath,
  validateNoteTitle,
} from './new-encrypted-note.model';

function folder(children: VaultFolderNode['children']): VaultFolderNode {
  return { type: 'folder', name: 'Work', relPath: 'Work', children };
}

describe('new-encrypted-note model', () => {
  describe('encryptedNoteNamesIn', () => {
    it('lists only the encrypted notes directly in the folder', () => {
      const names = encryptedNoteNamesIn(
        folder([
          { type: 'note', name: 'Secret', relPath: 'Work/Secret.mntl.enc', encrypted: true, profile: 'p' },
          // Same display name, different file: `Plain.mntl` never collides with `Plain.mntl.enc`.
          { type: 'note', name: 'Plain', relPath: 'Work/Plain.mntl', encrypted: false, profile: null },
          { type: 'folder', name: 'Nested', relPath: 'Work/Nested', children: [] },
        ]),
      );

      expect([...names]).toEqual(['Secret']);
    });

    it('is empty when the folder is unknown', () => {
      expect(encryptedNoteNamesIn(null).size).toBe(0);
    });
  });

  describe('nextUntitledName', () => {
    it('starts at Untitled', () => {
      expect(nextUntitledName(new Set())).toBe('Untitled');
    });

    it('skips taken names, numbering from 2', () => {
      expect(nextUntitledName(new Set(['Untitled']))).toBe('Untitled 2');
      expect(nextUntitledName(new Set(['Untitled', 'Untitled 2', 'Untitled 3']))).toBe('Untitled 4');
    });

    it('reuses a gap rather than always counting past the highest', () => {
      expect(nextUntitledName(new Set(['Untitled', 'Untitled 3']))).toBe('Untitled 2');
    });
  });

  describe('validateNoteTitle', () => {
    const none = new Set<string>();

    it('accepts an ordinary title', () => {
      expect(validateNoteTitle('Meeting notes', none)).toBeNull();
    });

    it('rejects a blank title', () => {
      expect(validateNoteTitle('', none)).toMatch(/title/i);
      expect(validateNoteTitle('   ', none)).toMatch(/title/i);
    });

    it.each(['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b'])('rejects an illegal character in %s', (title) => {
      expect(validateNoteTitle(title, none)).toMatch(/can't contain/);
    });

    it('rejects a trailing period, which Windows silently strips from filenames', () => {
      expect(validateNoteTitle('Draft.', none)).toMatch(/period/);
    });

    it('reports a collision with an existing encrypted note, ignoring surrounding whitespace', () => {
      expect(validateNoteTitle('Taken', new Set(['Taken']))).toMatch(/already exists/);
      expect(validateNoteTitle('  Taken  ', new Set(['Taken']))).toMatch(/already exists/);
    });
  });

  describe('on-disk names', () => {
    it('gives the encrypted extension to the trimmed title', () => {
      expect(onDiskFileName('  Ideas ')).toBe('Ideas.mntl.enc');
    });

    it('builds a vault-relative path, with no leading slash at the root', () => {
      expect(onDiskRelPath('', 'Ideas')).toBe('Ideas.mntl.enc');
      expect(onDiskRelPath('Work/Projects', 'Ideas')).toBe('Work/Projects/Ideas.mntl.enc');
    });
  });
});
