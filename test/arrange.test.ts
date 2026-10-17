import { describe, expect, it } from 'vitest';
import { compile, parseSong } from '../src/core/compile.ts';
import { expand } from '../src/core/patterns.ts';
import type { LaneItem, Song, SongInput } from '../src/core/schema.ts';
import * as arrange from '../src/app/arrange.ts';
import * as edits from '../src/app/edit.ts';
import * as effects from '../src/app/effects.ts';
import { editView, openView } from '../src/app/placements.ts';

const riff = { id: 'riff', kind: 'duty' as const, length: 8, items: [{ row: 0, len: 4, note: 'C5', inst: 1 }, { row: 4, len: 4, note: 'E5', inst: 1 }] };

function song(pulse1: object[], extra: Partial<SongInput> = {}): Song {
  const r = parseSong({
    version: 1,
    grid: { rowsPerBeat: 4, beatsPerBar: 4 },
    groove: [6, 6, 6, 6],
    length: 64,
    instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
    patterns: [riff],
    lanes: { pulse1: pulse1 as never },
    ...extra,
  });
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.song;
}

function ok(r: arrange.Arranged) {
  if (typeof r === 'string') throw new Error(r);
  return r;
}

const placed = (s: Song) => s.lanes.pulse1.map((i) => (i.pattern ? `${i.pattern}@${i.row}${i.repeat ? `x${i.repeat}` : ''}` : `${i.note}@${i.row}`));

describe('arranging placements', () => {
  it('moves and copies a placement, keeping it clear of what is there', () => {
    const s = song([{ row: 0, pattern: 'riff' }, { row: 32, len: 4, note: 'G5', inst: 1 }]);
    const item = s.lanes.pulse1[0]!;
    expect(placed(ok(arrange.movePlacement(s, 'pulse1', item, 8, false)).song)).toEqual(['riff@8', 'G5@32']);
    expect(placed(ok(arrange.movePlacement(s, 'pulse1', item, 16, true)).song)).toEqual(['riff@0', 'riff@16', 'G5@32']);
    expect(arrange.movePlacement(s, 'pulse1', item, 28, false)).toBe('G5 at 3.1.1 is in the way');
    expect(arrange.movePlacement(s, 'pulse1', item, 4, true)).toBe('pattern riff is at 1.1.1');
    expect(arrange.movePlacement(s, 'pulse1', item, 60, false)).toBe('that would run past the end of the song, at 5.1.1');
    expect(arrange.movePlacement(s, 'pulse1', item, -4, false)).toBe('that would be before the start of the song');
  });

  it('places it again after itself, and sets transpose and repeat, leaving out 0 and 1', () => {
    const s = song([{ row: 0, pattern: 'riff', repeat: 2 }]);
    const item = s.lanes.pulse1[0]!;
    expect(placed(ok(arrange.duplicatePlacement(s, 'pulse1', item)).song)).toEqual(['riff@0x2', 'riff@16x2']);
    const r = ok(arrange.setPlacement(s, 'pulse1', item, { transpose: 3, repeat: 1 }));
    expect(r.placement).toEqual({ row: 0, pattern: 'riff', transpose: 3 });
    expect(ok(arrange.setPlacement(r.song, 'pulse1', r.placement!, { transpose: 0 })).placement).toEqual({ row: 0, pattern: 'riff' });
    expect(arrange.setPlacement(s, 'pulse1', item, { repeat: 9 })).toBe('that would run past the end of the song, at 5.1.1');
  });

  it("sets a placement's instrument and len; a new repeat plays whole", () => {
    const s = song([{ row: 0, pattern: 'riff', repeat: 2 }]);
    const r = ok(arrange.setPlacement(s, 'pulse1', s.lanes.pulse1[0]!, { inst: 2, len: 12 }));
    expect(r.placement).toEqual({ row: 0, pattern: 'riff', repeat: 2, inst: 2, len: 12 });
    expect(ok(arrange.setPlacement(r.song, 'pulse1', r.placement!, { repeat: 3 })).placement).toEqual({ row: 0, pattern: 'riff', repeat: 3, inst: 2 });
    expect(ok(arrange.setPlacement(r.song, 'pulse1', r.placement!, { inst: undefined })).placement).toEqual({ row: 0, pattern: 'riff', repeat: 2, len: 12 });
    expect(arrange.setPlacement(s, 'pulse1', s.lanes.pulse1[0]!, { len: 4 })).toMatch(/^len 4 cuts short repeat 1/);
    expect(placed(ok(arrange.unpack(r.song, 'pulse1', r.placement!)).song)).toEqual(['C5@0', 'E5@4', 'C5@8']);
  });

  it('plays a placement for the rows its right edge is dragged to: repeating past its end, cut short between', () => {
    const s = song([{ row: 0, pattern: 'riff' }]);
    const item = s.lanes.pulse1[0]!;
    expect(ok(arrange.resizePlacement(s, 'pulse1', item, 16)).placement).toEqual({ row: 0, pattern: 'riff', repeat: 2 });
    expect(ok(arrange.resizePlacement(s, 'pulse1', item, 20)).placement).toEqual({ row: 0, pattern: 'riff', repeat: 3, len: 20 });
    expect(ok(arrange.resizePlacement(s, 'pulse1', item, 5)).placement).toEqual({ row: 0, pattern: 'riff', len: 5 });
    expect(ok(arrange.resizePlacement(s, 'pulse1', item, 8)).placement).toEqual({ row: 0, pattern: 'riff' });
    expect(arrange.resizePlacement(s, 'pulse1', item, 80)).toBe('that would run past the end of the song, at 5.1.1');
  });

  it('unpacks a placement into the notes it plays, transposed and repeated', () => {
    const s = song([{ row: 16, pattern: 'riff', transpose: 2, repeat: 2 }]);
    const r = ok(arrange.unpack(s, 'pulse1', s.lanes.pulse1[0]!));
    expect(placed(r.song)).toEqual(['D5@16', 'F#5@20', 'D5@24', 'F#5@28']);
    expect(r.selection).toHaveLength(4);
    expect(compile(r.song)).toEqual(compile(s));
  });

  it('makes a placement unique, copying its pattern', () => {
    const s = song([{ row: 0, pattern: 'riff' }, { row: 8, pattern: 'riff' }]);
    const r = ok(arrange.makeUnique(s, 'pulse1', s.lanes.pulse1[1]!));
    expect(placed(r.song)).toEqual(['riff@0', 'riff-2@8']);
    expect(r.song.patterns!.map((p) => p.id)).toEqual(['riff', 'riff-2']);
    expect(compile(r.song)).toEqual(compile(s));
  });

  it('renames a pattern everywhere, and refuses a name taken or with spaces at its ends', () => {
    const s = song([{ row: 0, pattern: 'riff' }, { row: 8, pattern: 'riff' }], { patterns: [riff, { ...riff, id: 'b' }] });
    expect(placed(ok(arrange.renamePattern(s, 'riff', 'lead')).song)).toEqual(['lead@0', 'lead@8']);
    expect(arrange.renamePattern(s, 'riff', 'b')).toBe("there's a pattern called b already");
    expect(arrange.renamePattern(s, 'riff', ' x')).toMatch(/^a pattern name is/);
  });

  it('makes a pattern of the beats the selected notes span, with everything in them', () => {
    const s = song([
      { row: 2, len: 2, note: 'C5', inst: 1 },
      { row: 8, fx: { vibrato: [4, 2] } },
      { row: 20, len: 4, note: 'D5', inst: 1 },
      { row: 40, len: 4, note: 'E5', inst: 1 },
    ]);
    const r = ok(arrange.makePattern(s, 'pulse1', [s.lanes.pulse1[0]!, s.lanes.pulse1[2]!]));
    expect(placed(r.song)).toEqual(['p2@0', 'E5@40']);
    expect(r.song.patterns![1]).toMatchObject({ id: 'p2', kind: 'duty', length: 24 });
    expect(r.song.patterns![1]!.items.map((i) => i.row)).toEqual([2, 8, 20]);
    expect(compile(r.song)).toEqual(compile(s));
  });

  it("won't make a pattern of beats a note runs out of, or that have a pattern in them", () => {
    const s = song([
      { row: 10, len: 4, note: 'C5', inst: 1 },
      { row: 14, len: 2, note: 'D5', inst: 1 },
      { row: 30, pattern: 'riff' },
      { row: 38, len: 2, note: 'D5', inst: 1 },
    ]);
    expect(arrange.makePattern(s, 'pulse1', [s.lanes.pulse1[1]!])).toBe('C5 at 1.3.3 runs across the edge of those beats');
    expect(arrange.makePattern(s, 'pulse1', [s.lanes.pulse1[3]!])).toBe('pattern riff is placed in those beats');
  });
});

describe('a place a pattern plays as the target of edits', () => {
  const s = song([{ row: 16, pattern: 'riff', transpose: 5, repeat: 3 }]);
  const open = { lane: 'pulse1' as const, start: 24, id: 'riff' }; // the second repeat

  it('shows the occurrence as notes where they play, the other repeats placed either side, playing the same', () => {
    const view = openView(s, open)!;
    expect(placed(view)).toEqual(['riff@16', 'F5@24', 'A5@28', 'riff@32']);
    expect(openView(s, open)).toBe(view);
    expect(compile(view)).toEqual(compile(s));
  });

  it("keeps the placement's len on the repeats after the target, and shows the pattern's own instruments", () => {
    const cut = song([{ row: 16, pattern: 'riff', repeat: 3, inst: 2, len: 20 }]);
    const view = openView(cut, open)!;
    expect(view.lanes.pulse1).toEqual([
      { row: 16, pattern: 'riff', inst: 2 },
      { row: 24, len: 4, note: 'C5', inst: 1 },
      { row: 28, len: 4, note: 'E5', inst: 1 },
      { row: 32, pattern: 'riff', inst: 2, len: 4 },
    ]);
    expect(openView(cut, { ...open, start: 32 })).toBeUndefined(); // cut short: never the target
  });

  it('writes edits back to the pattern, moved and transposed back, and keeps the selection drawable', () => {
    const { song: e, restore } = editView(s, 'pulse1', open);
    const [f5] = e.lanes.pulse1;
    const moved = edits.move(e, 'pulse1', [f5!], 1, 2);
    if (typeof moved === 'string') throw new Error(moved);
    const next = restore(moved.song);
    if (typeof next === 'string') throw new Error(next);
    // The moved note now covers where E5 started, so E5 goes, as when notes are moved onto others.
    expect(next.patterns![0]!.items).toEqual([{ row: 1, len: 4, note: 'D5', inst: 1 }]);
    expect(next.lanes).toBe(s.lanes);
    // Every place plays the change; the view of the new song holds the very notes the edit selected.
    expect(expand(next).song.lanes.pulse1.filter((i) => i.note === 'G5').map((i) => i.row)).toEqual([17, 25, 33]);
    expect(openView(next, open)!.lanes.pulse1).toContain(moved.selection[0]);
  });

  it("refuses edits where the transpose takes a note out of range, rather than guess what it was", () => {
    const high = song([{ row: 0, pattern: 'top', transpose: 1 }], {
      patterns: [{ id: 'top', kind: 'duty', length: 4, items: [{ row: 0, len: 4, note: 'B8', inst: 1 }] }],
    });
    const at = { lane: 'pulse1' as const, start: 0, id: 'top' };
    const { song: e, restore } = editView(high, 'pulse1', at);
    expect(e.lanes.pulse1[0]!.note).toBe('B8'); // shown as it is: B8 + 1 is past the note table
    expect(restore({ ...e, title: 'renamed' })).toBe('B8 in pattern top goes out of C3–B8 when this place transposes it by +1; change the transpose first');
    const fx = effects.setEffect(e, 'pulse1', 0, { volume: 7 }, []);
    if (typeof fx === 'string') throw new Error(fx);
    expect(typeof restore(fx.song)).toBe('string');
  });

  it("refuses an edit outside the occurrence's rows, or one that transposes back out of range", () => {
    const { song: e, restore } = editView(s, 'pulse1', open);
    const draw = (note: LaneItem) => restore(edits.draw(e, 'pulse1', note).song);
    expect(draw({ row: 40, len: 2, note: 'C5', inst: 1 })).toBe('notes in pattern riff stay between 2.3.1 and 3.1.1, where this place plays it');
    expect(draw({ row: 30, len: 4, note: 'C5', inst: 1 })).toBe('the note would run past the end of pattern riff, at 3.1.1');
    expect(draw({ row: 26, len: 1, note: 'D3', inst: 1 })).toBe('D3 would be below C3 in the pattern, which this place transposes by +5');
  });
});
