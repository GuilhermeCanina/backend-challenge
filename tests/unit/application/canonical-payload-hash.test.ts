import { describe, expect, test } from 'bun:test';
import { canonicalizeJson, hashCanonicalPayload } from '../../../src/application/idempotency/canonical-payload-hash.js';

describe('canonical payload hash', () => {
  test('sorts object keys recursively', () => {
    const left = { z: 1, nested: { b: true, a: 'x' }, a: 'first' };
    const right = { a: 'first', nested: { a: 'x', b: true }, z: 1 };
    expect(canonicalizeJson(left)).toBe(canonicalizeJson(right));
    expect(hashCanonicalPayload(left)).toBe(hashCanonicalPayload(right));
  });

  test('preserves array ordering', () => {
    expect(hashCanonicalPayload({ values: [1, 2] })).not.toBe(hashCanonicalPayload({ values: [2, 1] }));
  });

  test('rejects undefined, non-finite and circular values', () => {
    expect(() => canonicalizeJson({ value: undefined } as never)).toThrow();
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrow();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => canonicalizeJson(circular as never)).toThrow();
  });
});
