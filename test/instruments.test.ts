import { describe, expect, it } from 'vitest';
import { compile, parseSong } from '../src/core/compile.ts';
import type { Song } from '../src/core/schema.ts';
import {
  addInstrument,
  addWave,
  duplicateInstrument,
  noteCounts,
  removeInstrument,
  removeWave,
  renameWave,
  setNoteInstrument,
  setTable,
  setTableRow,
  setWave,
  TABLE_PRESETS,
  tablePresets,
  tableRows,
  updateInstrument,
  WAVE_PRESETS,
} from '../src/app/instruments.ts';

// The editor's edits to instruments and waves (docs/editor/, "Instruments and waves"), without a browser.

function song(more: object = {}): Song {
  const p = parseSong({
    version: 1,
    grid: { rowsPerBeat: 4, beatsPerBar: 4 },
    groove: [6, 6, 6, 6],
    length: 16,
    instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
    lanes: { pulse1: [{ row: 0, len: 4, note: 'C5', inst: 1 }] },
    ...more,
  });
  if (p.errors) throw new Error(JSON.stringify(p.errors));
  return p.song;
}

const ok = <T>(r: T | string): T => {
  if (typeof r === 'string') throw new Error(r);
  return r;
};

describe('instruments', () => {
  it('adds one of each kind that compiles and plays, making a wave when the song has none', () => {
    let s = song();
    for (const kind of ['duty', 'wave', 'noise'] as const) {
      const r = ok(addInstrument(s, kind));
      s = r.song;
      const lane = { duty: 'pulse2', wave: 'wave', noise: 'noise' }[kind];
      s = { ...s, lanes: { ...s.lanes, [lane]: [{ row: 0, len: 4, note: 'C5', inst: r.id }] } };
    }
    expect(s.instruments.duty.map((i) => i.id)).toEqual([1, 2]);
    expect(s.waves).toEqual([{ id: 0, data: WAVE_PRESETS.Triangle }]);
    expect(compile(s).ok).toBe(true);
  });

  it('takes the lowest free number, and stops at 15', () => {
    let s = song({ instruments: { duty: [1, 2, 4].map((id) => ({ id, duty: '50%', volume: 15 })) } });
    s = ok(addInstrument(s, 'duty')).song;
    expect(s.instruments.duty.map((i) => i.id)).toEqual([1, 2, 3, 4]);
    for (let n = 4; n < 15; n++) s = ok(addInstrument(s, 'duty')).song;
    expect(addInstrument(s, 'duty')).toMatch(/15 duty instruments/);
  });

  it('duplicates an instrument with its table and name', () => {
    const s = song({
      instruments: { duty: [{ id: 1, name: 'Lead', duty: '25%', volume: 9, table: [{ note: 12 }, { jump: 0 }] }] },
    });
    const r = ok(duplicateInstrument(s, 'duty', 1));
    expect(r.id).toBe(2);
    expect(r.song.instruments.duty[1]).toEqual({ ...s.instruments.duty[0], id: 2, name: 'Lead copy' });
    expect(r.song.instruments.duty[1]!.table).not.toBe(s.instruments.duty[0]!.table);
  });

  it("won't remove an instrument a note uses", () => {
    const s = ok(addInstrument(song(), 'duty')).song;
    expect(removeInstrument(s, 'duty', 1)).toMatch(/^1 note uses it/);
    expect(ok(removeInstrument(s, 'duty', 2)).instruments.duty.map((i) => i.id)).toEqual([1]);
  });

  it('counts notes on both pulse lanes for duty instruments', () => {
    const s = song({ lanes: { pulse1: [{ row: 0, len: 4, note: 'C5', inst: 1 }], pulse2: [{ row: 0, len: 4, note: 'C5', inst: 1 }] } });
    expect(noteCounts(s, 'duty').get(1)).toBe(2);
    expect(noteCounts(s, 'wave').size).toBe(0);
  });

  it("counts a pattern's notes once, placed or not, and won't remove an instrument only a pattern uses", () => {
    const riff = { id: 'riff', kind: 'duty' as const, length: 4, items: [{ row: 0, len: 4, note: 'C5', inst: 1 }] };
    const s = song({ patterns: [riff], lanes: { pulse1: [{ row: 0, pattern: 'riff', repeat: 2 }] } });
    expect(noteCounts(s, 'duty').get(1)).toBe(1);
    expect(noteCounts({ ...s, lanes: { ...s.lanes, pulse1: [] } }, 'duty').get(1)).toBe(1);
    expect(removeInstrument(s, 'duty', 1)).toMatch(/^1 note uses it/);
  });

  it('changes fields, and drops an empty name, leaving the notes as they are', () => {
    const before = song();
    let s = updateInstrument(before, 'duty', 1, { volume: 4, name: 'Pad' });
    expect(s.lanes).toBe(before.lanes);
    expect(s.instruments.duty[0]).toMatchObject({ volume: 4, name: 'Pad' });
    s = updateInstrument(s, 'duty', 1, { name: undefined });
    expect('name' in s.instruments.duty[0]!).toBe(false);
  });

  it('gives notes an instrument, leaving legato notes as they are', () => {
    const s = song({
      instruments: { duty: [1, 2].map((id) => ({ id, duty: '50%', volume: 15 })) },
      lanes: {
        pulse1: [
          { row: 0, len: 4, note: 'C5', inst: 1 },
          { row: 4, len: 4, note: 'D5', legato: true },
          { row: 8, len: 4, note: 'E5', inst: 1 },
        ],
      },
    });
    const notes = s.lanes.pulse1;
    const r = setNoteInstrument(s, 'pulse1', notes.slice(0, 2), 2);
    expect(r.song.lanes.pulse1.map((n) => n.inst)).toEqual([2, undefined, 1]);
    expect(r.selection).toEqual([r.song.lanes.pulse1[0], notes[1]]);
    expect(r.song.lanes.pulse1[2]).toBe(notes[2]);
  });
});

describe('waves', () => {
  it('has presets of 32 samples', () => {
    for (const data of Object.values(WAVE_PRESETS)) expect(data).toMatch(/^[0-9A-F]{32}$/);
  });

  it('adds waves at the lowest free number, up to 16, and replaces their samples', () => {
    let s = song({ waves: [{ id: 1, data: WAVE_PRESETS.Saw }] });
    const r = ok(addWave(s, WAVE_PRESETS.Square!));
    expect(r.id).toBe(0);
    s = setWave(r.song, 1, WAVE_PRESETS.Sine!);
    expect(s.waves).toEqual([
      { id: 0, data: WAVE_PRESETS.Square },
      { id: 1, data: WAVE_PRESETS.Sine },
    ]);
    for (let n = 2; n < 16; n++) s = ok(addWave(s, WAVE_PRESETS.Saw!)).song;
    expect(addWave(s, WAVE_PRESETS.Saw!)).toMatch(/16 waves/);
  });

  it('renames a wave, dropping an empty name', () => {
    let s = song({ waves: [{ id: 0, data: WAVE_PRESETS.Saw }] });
    s = renameWave(s, 0, 'buzz');
    expect(s.waves).toEqual([{ id: 0, name: 'buzz', data: WAVE_PRESETS.Saw }]);
    expect(renameWave(s, 0, undefined).waves).toEqual([{ id: 0, data: WAVE_PRESETS.Saw }]);
  });

  it('removes a wave nothing uses, the others keeping their numbers, and the song still compiles', () => {
    const s = song({
      instruments: { wave: [{ id: 1, wave: 2, level: '100%' }] },
      waves: [0, 1, 2].map((id) => ({ id, data: WAVE_PRESETS.Saw })),
      lanes: { wave: [{ row: 0, len: 4, note: 'C5', inst: 1 }] },
    });
    const r = ok(removeWave(s, 1));
    expect(r.waves.map((w) => w.id)).toEqual([0, 2]);
    expect(compile(r).ok).toBe(true);
  });

  it("won't remove a wave a wave instrument plays, used by notes or not", () => {
    const s = song({ instruments: { wave: [{ id: 3, wave: 0, level: '100%' }] }, waves: [{ id: 0, data: WAVE_PRESETS.Saw }] });
    expect(removeWave(s, 0)).toBe('wave 0 is used by wave instrument 3');
  });

  it("won't remove a wave a wave effect switches to, on the lane, in a table or in a pattern", () => {
    const waves = [0, 1, 2, 3].map((id) => ({ id, data: WAVE_PRESETS.Saw }));
    const s = song({
      instruments: { wave: [{ id: 1, wave: 0, level: '100%', table: [{}, { fx: { wave: 1 } }] }] },
      waves,
      patterns: [{ id: 'p', kind: 'wave', length: 4, items: [{ row: 0, fx: { wave: 2 } }] }],
      lanes: {
        wave: [
          { row: 4, fx: { wave: 3 } },
          { row: 8, len: 2, note: 'C5', inst: 1, fx: { wave: 3 } },
        ],
      },
    });
    expect(removeWave(s, 1)).toBe("wave 1 is used by wave instrument 1's table");
    expect(removeWave(s, 2)).toBe('wave 2 is used by a wave effect in pattern p');
    expect(removeWave(s, 3)).toBe('wave 3 is used by 2 wave effects on the wave lane, the first at 1.2.1');
  });

  it('counts a raw 9xx that reads across two waves as using both', () => {
    // 921 copies 16 bytes from byte 0x12: the end of wave 1 and the start of wave 2.
    const s = song({
      waves: [0, 1, 2, 3].map((id) => ({ id, data: WAVE_PRESETS.Saw })),
      lanes: { wave: [{ row: 4, fx: { raw: '921' } }] },
    });
    expect(removeWave(s, 1)).toMatch(/the wave effect at 1.2.1/);
    expect(removeWave(s, 2)).toMatch(/the wave effect at 1.2.1/);
    expect(typeof removeWave(s, 3)).not.toBe('string');
  });
});

describe('tables', () => {
  const withTable = (table?: object[]) => song({ instruments: { duty: [{ id: 1, duty: '50%', volume: 15, ...(table && { table }) }] } });
  const table = (s: Song) => s.instruments.duty[0]!.table;

  it('sets a row, making the table, and keeps rows only up to the last one used', () => {
    let s = setTableRow(withTable(), 'duty', 1, 3, { note: 12 });
    expect(table(s)).toEqual([{}, {}, {}, { note: 12 }]);
    s = setTableRow(s, 'duty', 1, 5, { fx: { volume: 0 } });
    s = setTableRow(s, 'duty', 1, 5, { note: undefined });
    expect(table(s)).toEqual([{}, {}, {}, { note: 12 }]);
  });

  it('removes a table with nothing in it, which plays the same as none', () => {
    const s = setTableRow(withTable([{ note: 12 }]), 'duty', 1, 0, {});
    expect('table' in s.instruments.duty[0]!).toBe(false);
  });

  it('has presets that compile and loop or hold as named', () => {
    for (const [name, rows] of Object.entries(TABLE_PRESETS)) {
      const s = setTable(withTable(), 'duty', 1, rows);
      expect(compile(s).ok, name).toBe(true);
      const last = rows.length - 1;
      expect(rows[last]!.jump, name).toBe(['Pluck', 'Fall', 'Duty sweep'].includes(name) ? last : 0);
    }
  });

  it('offers the duty sweep only to duty instruments', () => {
    expect(tablePresets('duty').map(([name]) => name)).toContain('Duty sweep');
    expect(tablePresets('wave').map(([name]) => name)).not.toContain('Duty sweep');
  });

  it('pads a table to 32 rows for showing', () => {
    expect(tableRows([{ note: 1 }])).toHaveLength(32);
    expect(tableRows(undefined).every((r) => Object.keys(r).length === 0)).toBe(true);
  });
});
