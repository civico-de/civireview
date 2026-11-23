import { describe, expect, test } from 'bun:test';
import { fetchAllPages } from '../src/evidence/github.ts';

const page = (n: number, size: number) => Array.from({ length: size }, (_, i) => `${n}:${i}`);

describe('fetchAllPages', () => {
  test('keeps requesting pages until a short page arrives, oldest first', async () => {
    const requested: number[] = [];
    const items = await fetchAllPages(async (p) => {
      requested.push(p);
      return p < 3 ? page(p, 100) : page(p, 7);
    });

    expect(requested).toEqual([1, 2, 3]);
    expect(items).toHaveLength(207);
    expect(items.at(-1)).toBe('3:6');
  });

  test('a single short page costs one request', async () => {
    let calls = 0;
    const items = await fetchAllPages(async () => {
      calls++;
      return page(1, 3);
    });
    expect(items).toHaveLength(3);
    expect(calls).toBe(1);
  });

  test('refuses a truncated list instead of silently dropping the newest items', async () => {
    await expect(fetchAllPages(async (p) => page(p, 100), 2)).rejects.toThrow(/truncated/);
  });
});
