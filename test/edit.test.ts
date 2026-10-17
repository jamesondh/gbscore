import { describe, expect, it } from 'vitest';
import { parseSong } from '../src/core/compile.ts';
import type { LaneItem, Song } from '../src/core/schema.ts';
import { expand } from '../src/core/patterns.ts';
import { compiles, compilesAfterEdits, demoSong } from './songs.ts';
import { copy, draw, drawAll, duplicate, isNote, move, paintRun, paste, remove, resize, type Result } from '../src/app/edit.ts';

// The editor's edits to notes (docs/editor/, "Web app"), without a browser.

function song(pulse1: LaneItem[], length = 32): Song {
  const p = parseSong({
    version: 1,
    grid: { rowsPerBeat: 4, beatsPerBar: 4 },
    groove: [6, 6, 6, 6],
    length,
    instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
    lanes: { pulse1 },
  });
  if (p.errors) throw new Error(JSON.stringify(p.errors));
  return p.song;
}

const n = (row: number, len: number, note = 'C5', more: Partial<LaneItem> = {}): LaneItem => ({ row, len, note, inst: 1, ...more });
const fx = (row: number): LaneItem => ({ row, fx: { vibrato: [4, 2] } });
const ok = (r: Result) => {
  if (typeof r === 'string') throw new Error(r);
  return r;
};

describe('placing notes', () => {
  it('shortens a note it starts inside, and removes what starts inside it', () => {
    const s = song([n(0, 8, 'C5', { cutTick: 2 }), fx(5), n(10, 2), n(13, 2), n(20, 4)]);
    const r = draw(s, 'pulse1', n(4, 10, 'E5'));
    expect(r.song.lanes.pulse1).toEqual([n(0, 4), n(4, 10, 'E5'), n(20, 4)]);
    expect(r.song.lanes.pulse1[2]).toBe(s.lanes.pulse1[4]); // untouched items keep their identity
    expect(r.selection).toEqual([n(4, 10, 'E5')]);
    compiles(r.song);
  });

  it("removes the effects of the notes it removes, and of the part of a note it cuts off", () => {
    const s = song([n(0, 12), fx(2), fx(9), n(14, 6), fx(16), fx(21), n(24, 2)]);
    const r = draw(s, 'pulse1', n(6, 10, 'E5'));
    expect(r.song.lanes.pulse1).toEqual([n(0, 6), fx(2), n(6, 10, 'E5'), fx(21), n(24, 2)]);
    compiles(r.song);
  });

  it('replaces a note on the same row', () => {
    const r = draw(song([n(4, 4)]), 'pulse1', n(4, 2, 'D5'));
    expect(r.song.lanes.pulse1).toEqual([n(4, 2, 'D5')]);
  });
});

describe('painting notes', () => {
  it('lays a note a slot, either way from the first, at the pitch each was painted', () => {
    const s = song([], 10);
    const pitches = new Map([[1, 26], [-1, 24], [0, 28], [2, 31]]);
    expect(paintRun(s, { row: 2, len: 4, inst: 1 }, pitches)).toEqual([n(2, 4, 'E5'), n(6, 4, 'D5')]);
    expect(paintRun(s, { row: 4, len: 4, inst: 1 }, pitches)).toEqual([n(0, 4), n(4, 4, 'E5'), n(8, 2, 'D5')]);
  });

  it('places them as drawn notes are, each taking the effect on its row', () => {
    const s = song([n(0, 8, 'G5'), fx(4), { row: 12, fx: { volume: 3 } }]);
    const r = drawAll(s, 'pulse1', [n(4, 4), n(8, 4), n(12, 4)]);
    expect(r.song.lanes.pulse1).toEqual([n(0, 4, 'G5'), n(4, 4, 'C5', { fx: { vibrato: [4, 2] } }), n(8, 4), n(12, 4, 'C5', { fx: { volume: 3 } })]);
    expect(r.selection).toHaveLength(3);
    compiles(r.song);
  });
});

describe('moving notes', () => {
  it('carries the effects inside them, and wins where it lands', () => {
    const s = song([n(0, 4), fx(2), n(8, 4, 'G5'), fx(9)]);
    const r = ok(move(s, 'pulse1', [s.lanes.pulse1[0]!], 7, 2));
    expect(r.song.lanes.pulse1).toEqual([n(7, 4, 'D5'), fx(9)]); // the G5 and its effect started inside it
    compiles(r.song);
  });

  it("says why it can't go past the note range or the song", () => {
    const s = song([n(0, 4, 'A8'), n(8, 4, 'C3')]);
    expect(move(s, 'pulse1', s.lanes.pulse1, 0, 3)).toBe('A8 is as high as it can go: notes end at B8');
    expect(move(s, 'pulse1', s.lanes.pulse1, 0, -1)).toBe('C3 is as low as it can go: notes start at C3');
    expect(move(s, 'pulse1', s.lanes.pulse1, -1, 0)).toBe('the notes are at the start of the song');
    expect(typeof move(s, 'pulse1', s.lanes.pulse1, 21, 0)).toBe('string');
    expect(ok(move(s, 'pulse1', s.lanes.pulse1, 20, 2)).song.lanes.pulse1.map((i) => i.note)).toEqual(['B8', 'D3']);
  });

  it('moves a selection together, without the notes in it cutting each other short', () => {
    const s = song([n(0, 4), n(4, 4, 'D5'), n(8, 4, 'E5')]);
    const r = ok(move(s, 'pulse1', s.lanes.pulse1, 2, 0));
    expect(r.song.lanes.pulse1).toEqual([n(2, 4), n(6, 4, 'D5'), n(10, 4, 'E5')]);
    expect(r.selection).toHaveLength(3);
  });
});

describe('resizing notes', () => {
  it('keeps their own effects and clears what they grow over', () => {
    const s = song([n(0, 4, 'C5', { cutTick: 1 }), fx(2), n(4, 4, 'D5'), fx(6), n(12, 2)]);
    const r = resize(s, 'pulse1', [s.lanes.pulse1[0]!], 6);
    expect(r.song.lanes.pulse1).toEqual([n(0, 10), fx(2), n(12, 2)]);
    compiles(r.song);
  });

  it('drops their effects past their new end when they get shorter', () => {
    const s = song([n(0, 8), fx(2), fx(6), n(8, 2)]);
    expect(resize(s, 'pulse1', [s.lanes.pulse1[0]!], -4).song.lanes.pulse1).toEqual([n(0, 4), fx(2), n(8, 2)]);
  });

  it('keeps notes at least a row long and inside the song', () => {
    const s = song([n(0, 2), n(28, 2)]);
    expect(resize(s, 'pulse1', s.lanes.pulse1, -5).song.lanes.pulse1).toEqual([n(0, 1), n(28, 1)]);
    expect(resize(s, 'pulse1', s.lanes.pulse1, 9).song.lanes.pulse1).toEqual([n(0, 11), n(28, 4)]);
  });

  it('stops each short of the next one resized with it', () => {
    const s = song([n(0, 4), n(4, 4, 'D5')]);
    const r = resize(s, 'pulse1', s.lanes.pulse1, 2);
    expect(r.song.lanes.pulse1).toEqual([n(0, 4), n(4, 6, 'D5')]);
    compiles(r.song);
  });

  it('changes nothing when the length stays the same', () => {
    const s = song([n(0, 2, 'C5', { cutTick: 1 })]);
    expect(resize(s, 'pulse1', s.lanes.pulse1, 0).song.lanes.pulse1[0]).toBe(s.lanes.pulse1[0]);
  });
});

describe('copy, paste, duplicate and delete', () => {
  it('pastes notes and their effects at a row', () => {
    const s = song([n(2, 4), fx(3), n(6, 2, 'D5')]);
    const clip = copy(s, 'pulse1', s.lanes.pulse1.filter(isNote))!;
    expect(clip.span).toBe(6);
    const r = ok(paste(s, 'pulse1', clip, 16));
    expect(r.song.lanes.pulse1.slice(3)).toEqual([n(16, 4), fx(17), n(20, 2, 'D5')]);
    expect(paste(s, 'pulse1', clip, 27)).toMatch(/there isn't room/);
  });

  it('duplicates a whole number of beats on', () => {
    const s = song([n(1, 2), n(3, 3)]);
    const r = ok(duplicate(s, 'pulse1', s.lanes.pulse1));
    expect(r.song.lanes.pulse1.map((i) => i.row)).toEqual([1, 3, 9, 11]);
    expect(r.selection.map((i) => i.row)).toEqual([9, 11]);
  });

  it('deletes notes with their effects', () => {
    const s = song([n(0, 4), fx(2), n(4, 4), fx(5)]);
    expect(remove(s, 'pulse1', [s.lanes.pulse1[0]!]).song.lanes.pulse1).toEqual([n(4, 4), fx(5)]);
  });
});

describe('edits to whole songs', () => {
  it('the demo song, its patterns written out, still compiles after moving, duplicating and deleting', () => {
    compilesAfterEdits(expand(demoSong()).song);
  });
});
