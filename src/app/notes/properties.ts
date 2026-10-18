/**
 * Note properties: the user's own frontmatter keys besides `tags`. Values
 * arrive from the backend as JSON (`vault.rs` `NoteProperty`), in the order
 * the note lists them.
 */

export type PropertyValue = string | number | boolean | null | PropertyValue[] | { [key: string]: PropertyValue };

export interface NoteProperty {
  key: string;
  value: PropertyValue;
}

export type PropertyType = 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime';

export const PROPERTY_TYPES: readonly { id: PropertyType; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'list', label: 'List' },
  { id: 'number', label: 'Number' },
  { id: 'checkbox', label: 'Checkbox' },
  { id: 'date', label: 'Date' },
  { id: 'datetime', label: 'Date & Time' },
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function isScalar(value: PropertyValue): value is string | number | boolean | null {
  return value === null || typeof value !== 'object';
}

/** Whether `value` can be shown and edited as a `type`. Empty (null) fits every type. */
export function fitsType(value: PropertyValue, type: PropertyType): boolean {
  if (value === null) return true;
  switch (type) {
    case 'text':
      return typeof value === 'string';
    case 'list':
      return Array.isArray(value) && value.every((item) => isScalar(item) && item !== null);
    case 'number':
      return typeof value === 'number';
    case 'checkbox':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && DATE.test(value);
    case 'datetime':
      return typeof value === 'string' && DATETIME.test(value);
  }
}

/** The type `value` reads as, or null for one no type can edit (a nested map, say), shown read-only. */
export function inferType(value: PropertyValue): PropertyType | null {
  for (const type of ['checkbox', 'number', 'list', 'date', 'datetime', 'text'] as const) {
    if (value !== null && fitsType(value, type)) return type;
  }
  return value === null ? 'text' : null;
}

/**
 * The type a property shows as: the vault's type for its name when the value
 * fits it, else whatever the value itself reads as. A value that doesn't fit
 * its vault type (`due: next week`) is never coerced just by being shown.
 */
export function propertyType(value: PropertyValue, vaultType: PropertyType | undefined): PropertyType | null {
  return vaultType && fitsType(value, vaultType) ? vaultType : inferType(value);
}

/** `value` converted to `type` as best it can be, or null (empty) when it can't. */
export function convertValue(value: PropertyValue, type: PropertyType): PropertyValue {
  if (fitsType(value, type)) return value;
  const items = Array.isArray(value) ? value.filter(isScalar).map(String) : value === null ? [] : [String(value)];
  const text = items.join(', ');
  switch (type) {
    case 'text':
      return text || null;
    case 'list':
      return Array.isArray(value) ? items : text.split(',').map((item) => item.trim()).filter(Boolean);
    case 'number': {
      const number = Number(text);
      return text && Number.isFinite(number) ? number : null;
    }
    case 'checkbox':
      return text === 'true' || text === 'yes';
    case 'date':
      return DATETIME.test(text) ? text.slice(0, 10) : null;
    case 'datetime':
      return DATE.test(text) ? `${text}T00:00` : null;
  }
}

/** A value no type can edit, as text to show read-only. */
export function displayValue(value: PropertyValue): string {
  return JSON.stringify(value);
}

/** The key `state.json` files a property's vault-wide type under: names match case-insensitively. */
export function propertyTypeKey(name: string): string {
  return name.toLowerCase();
}

export function sameProperties(a: readonly NoteProperty[] | null, b: readonly NoteProperty[] | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
