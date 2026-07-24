import { SLASH_COMMAND_ITEMS, filterSlashCommands } from './slash-menu.model';

describe('filterSlashCommands', () => {
  it('returns all items for an empty query', () => {
    expect(filterSlashCommands('')).toEqual(SLASH_COMMAND_ITEMS);
    expect(filterSlashCommands('   ')).toEqual(SLASH_COMMAND_ITEMS);
  });

  it('matches items by label', () => {
    const result = filterSlashCommands('head');
    expect(result.map((item) => item.id)).toEqual(['h1', 'h2', 'h3']);
  });

  it('matches items by keyword', () => {
    const result = filterSlashCommands('todo');
    expect(result.map((item) => item.id)).toEqual(['task-list']);
  });

  it('is case-insensitive', () => {
    expect(filterSlashCommands('DIVIDER').map((item) => item.id)).toEqual(['divider']);
  });

  it('returns an empty array for a nonsense query', () => {
    expect(filterSlashCommands('xyzzy')).toEqual([]);
  });
});
