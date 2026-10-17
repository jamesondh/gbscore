import { describe, expect, it } from 'vitest';
import { parseSong } from '../src/core/compile.ts';
import { model } from '../src/app/roll/draw.ts';

describe('the piano roll', () => {
  it('ends a cut note where the driver cuts it, at the tempo the row plays at', () => {
    const p = parseSong({
      version: 1,
      grid: { rowsPerBeat: 4, beatsPerBar: 4 },
      groove: [6, 6, 6, 6],
      length: 8,
      instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
      lanes: { pulse1: [{ row: 0, len: 1, note: 'C5', inst: 1, cutTick: 2 }] },
      global: [{ row: 0, tempo: 3 }],
    });
    if (p.errors) throw new Error(JSON.stringify(p.errors));
    expect(model(p.song).lanes.pulse1.notes[0]!.end).toBeCloseTo(2 / 3);
  });
});
