import { describe, expect, it } from 'vitest';

import {
  arrayOf,
  finiteNumberOf,
  isRecord,
  recordOr,
  stringOf,
  stringsOf,
  unixSecondsOf,
} from '../src/boundary.js';

/**
 * The readers themselves, at the edges the tools rely on.
 *
 * The suites beside this one drive them through the server, which is where the
 * behaviour that matters is. These are the boundaries of each answer, stated
 * once — because "returns undefined for the wrong shape" is a claim every caller
 * in `messages.ts` and `read.ts` is written against.
 */

describe('isRecord and its two conveniences', () => {
  it('is true for a plain object and nothing else', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const value of [null, undefined, [], 'x', 5, true]) {
      expect(isRecord(value), String(value)).toBe(false);
    }
  });

  it('recordOr answers an empty record rather than throwing', () => {
    expect(recordOr(null)).toEqual({});
    expect(recordOr('nope')).toEqual({});
    expect(recordOr({ a: 1 })).toEqual({ a: 1 });
  });

  it('arrayOf answers an empty list rather than throwing', () => {
    expect(arrayOf(null)).toEqual([]);
    expect(arrayOf({ length: 3 })).toEqual([]);
    expect(arrayOf([1, 2])).toEqual([1, 2]);
  });
});

describe('stringOf', () => {
  it('refuses to stringify what is not a string', () => {
    // `String(42)` would invent a title nobody wrote, and `String({})` is
    // "[object Object]", which looks like a name.
    expect(stringOf('a')).toBe('a');
    expect(stringOf('')).toBe('');
    for (const value of [42, true, null, undefined, {}, []]) {
      expect(stringOf(value), String(value)).toBeUndefined();
    }
  });
});

describe('finiteNumberOf', () => {
  it('refuses what zod refuses', () => {
    expect(finiteNumberOf(5)).toBe(5);
    expect(finiteNumberOf(-1.5)).toBe(-1.5);
    for (const value of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      '5',
      null,
      undefined,
    ]) {
      expect(finiteNumberOf(value), String(value)).toBeUndefined();
    }
  });

  it('normalises negative zero, which splits the two channels', () => {
    // The text block would say `0` and the structured half `-0`, and a test
    // that compares the two would fail on a value that is not wrong.
    expect(Object.is(finiteNumberOf(-0), 0)).toBe(true);
  });
});

describe('unixSecondsOf', () => {
  it('accepts what Date accepts', () => {
    expect(unixSecondsOf(1_787_820_062)).toBe(1_787_820_062);
    expect(unixSecondsOf(0)).toBe(0);
    expect(unixSecondsOf(-1)).toBe(-1);
  });

  it('refuses what would make toISOString throw', () => {
    // The narrower range is the one that matters: `Number.isSafeInteger` is
    // four orders of magnitude too generous here, and the failure it lets
    // through is a RangeError thrown out of a projection inside a listing.
    for (const value of [8.64e12 + 1, -8.64e12 - 1, 9e15, Number.NaN, 'now']) {
      expect(unixSecondsOf(value), String(value)).toBeUndefined();
    }
    // The boundary itself is inside.
    expect(unixSecondsOf(8.64e12)).toBe(8.64e12);
    expect(() => new Date(8.64e12 * 1000).toISOString()).not.toThrow();
  });
});

describe('stringsOf', () => {
  it('drops holes instead of reporting them as values', () => {
    expect(stringsOf(['a', null, 5, 'b'], 10)).toEqual(['a', 'b']);
  });

  it('stops at the ceiling', () => {
    expect(
      stringsOf(
        Array.from({ length: 100 }, () => 'x'),
        3
      )
    ).toHaveLength(3);
  });

  it('answers an empty list for something that is not one', () => {
    expect(stringsOf('abc', 10)).toEqual([]);
    expect(stringsOf(null, 10)).toEqual([]);
  });
});
