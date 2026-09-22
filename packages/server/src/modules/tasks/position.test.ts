import { describe, expect, it } from 'vitest';
import { append, between } from './position.js';

describe('where a task sits in its column', () => {
  it('opens an empty column in the middle, so there is room on both sides', () => {
    const only = between(null, null);
    expect(only > 'a').toBe(true);
    expect(only < 'z').toBe(true);
  });

  it('keeps a whole column sorted after a hundred inserts at the end', () => {
    const keys: string[] = [];
    let last: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      last = append(last);
      keys.push(last);
    }
    expect([...keys].sort()).toEqual(keys);
  });

  it('keeps a whole column sorted after a hundred inserts in the middle', () => {
    let low = between(null, null);
    const high = append(low);
    const keys = [low, high];
    for (let i = 0; i < 100; i += 1) {
      const key = between(low, high);
      keys.splice(keys.indexOf(low) + 1, 0, key);
      low = key;
    }
    expect([...keys].sort()).toEqual(keys);
  });

  it('appends after the last one', () => {
    const first = between(null, null);
    const second = append(first);
    expect(second > first).toBe(true);
  });

  it('puts a task before the first one', () => {
    const first = 'n';
    const before = between(null, first);
    expect(before < first).toBe(true);
  });

  it('puts a task between two neighbours', () => {
    const key = between('a', 'b');
    expect(key > 'a').toBe(true);
    expect(key < 'b').toBe(true);
  });

  it('never runs out of room between two keys, however many times it is asked', () => {
    let low = 'a';
    const high = 'b';
    for (let i = 0; i < 50; i += 1) {
      const key = between(low, high);
      expect(key > low, `round ${i}`).toBe(true);
      expect(key < high, `round ${i}`).toBe(true);
      low = key;
    }
  });

  it('keeps a whole column sorted after a hundred inserts at the front', () => {
    const keys: string[] = [];
    let first: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      first = between(null, first);
      keys.unshift(first);
    }
    expect([...keys].sort()).toEqual(keys);
  });

  it('does not crash on a reversed pair; it answers after the first one', () => {
    const key = between('z', 'a');
    expect(key > 'z').toBe(true);
  });
});
