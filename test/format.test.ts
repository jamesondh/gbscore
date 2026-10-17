import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile, parseSong } from '../src/core/compile.ts';
import { formatSong } from '../src/core/format.ts';
import { importUge } from '../src/core/import.ts';
import { jsonSchema } from '../src/core/json-schema.ts';
import { demoSong, fixture, survivesRoundTrip } from './songs.ts';

describe('canonical form', () => {
  it("HALT Bug's .uge survives a round trip through the file", () => {
    survivesRoundTrip(importUge(readFileSync(fixture('halt_bug.uge'))).song);
  });

  it('the demo song survives a round trip through the file', () => survivesRoundTrip(demoSong()));

  it('sorts items, orders keys and fills defaults', () => {
    const parsed = parseSong({
      lanes: {
        pulse1: [
          { inst: 1, note: 'D5', len: 2, row: 8 },
          { fx: { vibrato: [4, 2] }, row: 2 },
          { row: 0, note: 'C5', len: 2, inst: 1 },
        ],
      },
      instruments: { duty: [{ volume: 9, duty: '25%', id: 2 }, { id: 1, duty: '50%', volume: 15 }] },
      global: [{ pan: ['LR', 'LR', 'LR', 'LR'], row: 0 }, { tempo: 4, row: 0 }],
      length: 16,
      groove: [6, 6, 6, 6],
      grid: { beatsPerBar: 4, rowsPerBeat: 4 },
      version: 1,
    });
    if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
    const text = formatSong(parsed.song);
    expect(text).toBe(
      `{
  "version": 1,
  "grid": { "rowsPerBeat": 4, "beatsPerBar": 4 },
  "groove": [6, 6, 6, 6],
  "length": 16,
  "loop": 0,
  "instruments": {
    "duty": [
      {
        "id": 1,
        "duty": "50%",
        "volume": 15,
        "envDir": "down",
        "envPace": 0,
        "sweepTime": 0,
        "sweepDir": "down",
        "sweepShift": 0,
        "length": 0,
        "lengthEnabled": false
      },
      {
        "id": 2,
        "duty": "25%",
        "volume": 9,
        "envDir": "down",
        "envPace": 0,
        "sweepTime": 0,
        "sweepDir": "down",
        "sweepShift": 0,
        "length": 0,
        "lengthEnabled": false
      }
    ],
    "wave": [],
    "noise": []
  },
  "waves": [],
  "lanes": {
    "pulse1": [
      { "row": 0, "len": 2, "note": "C5", "inst": 1 },
      { "row": 2, "fx": { "vibrato": [4, 2] } },
      { "row": 8, "len": 2, "note": "D5", "inst": 1 }
    ],
    "pulse2": [],
    "wave": [],
    "noise": []
  },
  "global": [
    { "row": 0, "tempo": 4 },
    { "row": 0, "pan": ["LR", "LR", "LR", "LR"] }
  ]
}
`,
    );
  });
});

describe('repository checks', () => {
  it("README's example song compiles", () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const parsed = parseSong(JSON.parse(/```json\n([\s\S]*?)```/.exec(readme)![1]!));
    if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
    expect(compile(parsed.song).ok).toBe(true);
  });

  it('schema/gbscore.schema.json is up to date (npm run schema)', () => {
    expect(readFileSync(new URL('../schema/gbscore.schema.json', import.meta.url), 'utf8')).toBe(jsonSchema());
  });

  it('src/core and src/play use no Node or browser APIs, so the app and the CLI can share them', () => {
    for (const part of ['core', 'play']) {
      const dir = new URL(`../src/${part}/`, import.meta.url);
      for (const file of readdirSync(dir)) {
        const text = readFileSync(new URL(file, dir), 'utf8');
        expect(text, `${part}/${file}`).not.toMatch(/from 'node:|require\(|\bdocument\.|\bwindow\./);
      }
    }
  });
});
