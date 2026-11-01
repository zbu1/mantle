import { lineDiff } from './line-diff';

describe('lineDiff', () => {
  it('marks added and removed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'add', text: 'x' },
      { kind: 'remove', text: 'b' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('reports no changes for equal text', () => {
    expect(lineDiff('a\nb', 'a\nb').every((line) => line.kind === 'same')).toBe(true);
  });
});
