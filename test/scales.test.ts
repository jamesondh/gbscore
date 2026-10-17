import { describe, expect, it } from 'vitest';
import { parseSong } from '../src/core/compile.ts';
import { bestRoot, inScale, scaleName } from '../src/app/scales.ts';

// The scales the roll shades (docs/editor/, "Web app").

describe('scales', () => {
  it('holds the notes of a key, whatever the octave', () => {
    const a = { root: 9, kind: 'minor' } as const;
    expect([24, 26, 28, 29, 31, 33, 35].map((n) => inScale(a, n))).toEqual([true, true, true, true, true, true, true]);
    expect([25, 27, 30, 32, 34].some((n) => inScale(a, n))).toBe(false);
    expect(inScale(a, 33 + 36)).toBe(true);
    expect(scaleName(a)).toBe('A minor');
  });

  it("picks the root that fits most of the song's notes, by rows held, leaving out the noise lane, and the longest-held root of ones that tie", () => {
    const p = parseSong({
      version: 1,
      grid: { rowsPerBeat: 4, beatsPerBar: 4 },
      groove: [6, 6, 6, 6],
      length: 64,
      instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }], noise: [{ id: 1, volume: 15 }] },
      lanes: {
        pulse1: [
          { row: 0, len: 12, note: 'A5', inst: 1 },
          { row: 12, len: 4, note: 'C6', inst: 1 },
          { row: 16, len: 4, note: 'E6', inst: 1 },
          { row: 20, len: 1, note: 'G#5', inst: 1 }, // a leading note, too short to move the key
        ],
        noise: [{ row: 0, len: 64, note: 'C#5', inst: 1 }],
      },
    });
    if (p.errors) throw new Error(JSON.stringify(p.errors));
    // A, C and E fit D, E and A minor; A is held longest.
    expect(bestRoot(p.song, 'minor')).toBe(9);
    // They fit C, F and G major; none is held, so the lowest.
    expect(bestRoot(p.song, 'major')).toBe(0);
  });
});
