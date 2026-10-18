import { convertValue, fitsType, inferType, propertyType } from './properties';

describe('properties', () => {
  it('infers a type from the value', () => {
    expect(inferType(true)).toBe('checkbox');
    expect(inferType(3.5)).toBe('number');
    expect(inferType(['a', 2])).toBe('list');
    expect(inferType('2026-10-17')).toBe('date');
    expect(inferType('2026-10-17T09:30')).toBe('datetime');
    expect(inferType('2026-10-17 09:30:00Z')).toBe('datetime');
    expect(inferType('hello')).toBe('text');
    expect(inferType(null)).toBe('text');
    expect(inferType({ nested: 1 })).toBeNull();
    expect(inferType([['nested']])).toBeNull();
  });

  it("uses the vault's type only when the value fits it", () => {
    expect(propertyType('2026-10-17', 'text')).toBe('text');
    expect(propertyType('next week', 'date')).toBe('text');
    expect(propertyType(null, 'checkbox')).toBe('checkbox');
    expect(fitsType(null, 'list')).toBe(true);
  });

  it('converts values between types as best it can', () => {
    expect(convertValue('a, b ,', 'list')).toEqual(['a', 'b']);
    expect(convertValue(['a', 'b'], 'text')).toBe('a, b');
    expect(convertValue('12', 'number')).toBe(12);
    expect(convertValue('twelve', 'number')).toBeNull();
    expect(convertValue('2026-10-17T09:30', 'date')).toBe('2026-10-17');
    expect(convertValue('2026-10-17', 'datetime')).toBe('2026-10-17T00:00');
    expect(convertValue('true', 'checkbox')).toBe(true);
    expect(convertValue(null, 'list')).toBeNull();
    expect(convertValue(null, 'text')).toBeNull();
  });
});
