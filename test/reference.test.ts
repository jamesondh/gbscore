import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/core/compile.ts';
import type { DriverSong } from '../src/core/driver.ts';
import { importUge } from '../src/core/import.ts';
import { readReference } from './reference.ts';
import { demoSong, fixture } from './songs.ts';

// Pass 1's acceptance (docs/editor/, "Passes"): import each test song, compile it, and compare with the C that
// uge2source writes for the same .uge.

function ours(name: string): DriverSong {
  const { song, errors } = importUge(readFileSync(fixture(`${name}.uge`)));
  expect(errors).toEqual([]);
  const result = compile(song);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.data;
}

function reference(name: string): DriverSong {
  return readReference(fixture(`${name}.uge2source.c`).pathname);
}

describe("HALT Bug's .uge keeps its layout", () => {
  const a = ours('halt_bug');
  const b = reference('halt_bug');

  it('has the same groove and orders', () => {
    expect(a.groove).toEqual(b.groove);
    expect(a.orders[0]!.length).toBe(b.orders[0]!.length);
    expect(a.patterns.length).toBe(b.patterns.length);
  });

  it('has the same pattern in every order of every channel', () => {
    for (let ch = 0; ch < 4; ch++) {
      for (let i = 0; i < b.orders[ch]!.length; i++) {
        expect(a.patterns[a.orders[ch]![i]!], `channel ${ch + 1} order ${i}`).toEqual(b.patterns[b.orders[ch]![i]!]);
      }
    }
  });

  it('has the same instruments and waves', () => {
    expect(a.duty).toEqual(b.duty);
    expect(a.wave).toEqual(b.wave);
    expect(a.noise).toEqual(b.noise);
    expect(a.waves).toEqual(b.waves);
  });
});

// halt_bug.uge was written from the demo song by scripts/song-to-uge.ts, so uge2source's C checks the compiler on
// the demo song too.
it("HALT Bug's .uge compiles to the same bytes as the demo song", () => {
  const c = compile(demoSong());
  if (!c.ok) throw new Error(c.errors.map((e) => e.message).join('\n'));
  expect(ours('halt_bug')).toEqual(c.data);
});
