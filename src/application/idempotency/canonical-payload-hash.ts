import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Stable JSON representation: object keys are sorted recursively; array order is preserved. */
export function canonicalizeJson(value: JsonValue): string {
  return encode(value, new Set<object>());
}

/** SHA-256 for the validated request body only; transport headers must not be passed here. */
export function hashCanonicalPayload(value: JsonValue): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON does not support non-finite numbers.');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('Canonical JSON cannot contain circular references.');
    ancestors.add(value);
    const result = `[${value.map((item) => encode(item, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return result;
  }

  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON accepts only plain objects.');
    }
    if (ancestors.has(object)) throw new TypeError('Canonical JSON cannot contain circular references.');
    ancestors.add(object);

    const keys = Object.keys(object).sort();
    const fields = keys.map((key) => {
      const fieldValue = object[key];
      if (fieldValue === undefined) {
        throw new TypeError(`Canonical JSON does not support undefined values (field: ${key}).`);
      }
      return `${JSON.stringify(key)}:${encode(fieldValue, ancestors)}`;
    });

    ancestors.delete(object);
    return `{${fields.join(',')}}`;
  }

  throw new TypeError(`Canonical JSON does not support values of type ${typeof value}.`);
}
