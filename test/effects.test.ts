import { describe, expect, it } from 'vitest';
import { compile, parseSong } from '../src/core/compile.ts';
import type { Song } from '../src/core/schema.ts';
import { draw } from '../src/app/edit.ts';
import {
  bpm,
  copyEffects,
  drawVolume,
  effectAt,
  effectsOn,
  endRows,
  globalAt,
  longEffect,
  moveEffects,
  pasteEffects,
  removeEffects,
  setCutTick,
  setEffect,
  setGlobal,
  ticksAt,
} from '../src/app/effects.ts';

// The editor's edits to effects on the timeline (docs/editor/, "Effects on the timeline"), without a browser.

function song(more: object = {}): Song {
  const p = parseSong({
    version: 1,
    grid: { rowsPerBeat: 4, beatsPerBar: 4 },
    groove: [6, 6, 6, 6],
    length: 16,
    instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
    lanes: { pulse1: [{ row: 0, len: 4, note: 'C5', inst: 1 }, { row: 8, len: 2, note: 'E5', inst: 1 }] },
    ...more,
  });
  if (p.errors) throw new Error(JSON.stringify(p.errors));
  return p.song;
}

const ok = <T>(r: T | string): T => {
  if (typeof r === 'string') throw new Error(r);
  return r;
};

describe('lane effects', () => {
  it("puts an effect on a note's row in the note's fx, keeping it selected", () => {
    const s = song();
    const note = s.lanes.pulse1[0]!;
    const r = ok(setEffect(s, 'pulse1', 0, { volume: 9 }, [note]));
    expect(r.song.lanes.pulse1[0]).toEqual({ ...note, fx: { volume: 9 } });
    expect(r.selection).toEqual([r.song.lanes.pulse1[0]]);
    expect(r.song.lanes.pulse1[1]).toBe(s.lanes.pulse1[1]);
    const gone = ok(setEffect(r.song, 'pulse1', 0, undefined, []));
    expect(gone.song.lanes.pulse1[0]).toEqual(note);
    expect(compile(r.song).ok).toBe(true);
  });

  it('puts an effect on any other row in an item without a note, in row order', () => {
    const s = song();
    const r = ok(setEffect(s, 'pulse1', 2, { vibrato: [4, 2] }, []));
    expect(r.song.lanes.pulse1.map((i) => i.row)).toEqual([0, 2, 8]);
    expect(r.song.lanes.pulse1[1]).toEqual({ row: 2, fx: { vibrato: [4, 2] } });
    expect(effectAt(r.song, 'pulse1', 2)).toEqual({ fx: { vibrato: [4, 2] }, note: undefined, inside: s.lanes.pulse1[0] });
    // Changing it replaces it; none removes it.
    const changed = ok(setEffect(r.song, 'pulse1', 2, { slideDown: 3 }, []));
    expect(changed.song.lanes.pulse1.filter((i) => i.row === 2)).toEqual([{ row: 2, fx: { slideDown: 3 } }]);
    expect(ok(setEffect(changed.song, 'pulse1', 2, undefined, [])).song.lanes.pulse1).toEqual(s.lanes.pulse1);
    // Past every note too, and after the last item.
    const after = ok(setEffect(s, 'pulse1', 14, { cut: 1 }, []));
    expect(after.song.lanes.pulse1.at(-1)).toEqual({ row: 14, fx: { cut: 1 } });
    expect(effectAt(after.song, 'pulse1', 14).inside).toBeUndefined();
    expect(compile(after.song).ok).toBe(true);
  });

  it("won't put a cut in a note, or go past the song", () => {
    expect(setEffect(song(), 'pulse1', 0, { cut: 1 }, [])).toMatch(/shorten the note/);
    expect(setEffect(song(), 'pulse1', 2, { cut: 1 }, [])).toMatch(/shorten the note/);
    expect(setEffect(song(), 'pulse1', 16, { volume: 1 }, [])).toMatch(/isn't in the song/);
  });

  // The strip showed these rows as free, and an effect put there made a compile error.
  it("keeps the rows a note's end needs, and says why", () => {
    const s = song({
      lanes: {
        pulse1: [
          { row: 0, len: 4, note: 'C5', inst: 1 }, // cut at 4
          { row: 4, len: 4, note: 'D5', inst: 1 }, // the next note starts at its end: no cut, then cut at 8
          { row: 10, len: 1, note: 'E5', inst: 1, cutTick: 2 }, // its own row
          { row: 12, len: 4, note: 'F5', inst: 1 }, // ends with the song
        ],
      },
    });
    expect([...endRows(s, 'pulse1').keys()]).toEqual([8, 10]);
    expect(setEffect(s, 'pulse1', 8, { volume: 3 }, [])).toMatch(/note at 1\.2\.1 ends here and its cut needs/);
    expect(setEffect(s, 'pulse1', 10, { volume: 3 }, [])).toMatch(/its cutTick needs/);
    // Each refused edit would have been a compile error.
    for (const row of [8, 10]) {
      const forced = { ...s, lanes: { pulse1: [...s.lanes.pulse1, { row, fx: { volume: 3 } }].sort((a, b) => a.row - b.row) } } as Song;
      expect(compile(forced).ok).toBe(false);
    }
    // Rows that are free still take one.
    expect(compile(ok(setEffect(s, 'pulse1', 4, { volume: 3 }, [])).song).ok).toBe(true);
    // An effect already in the way can still go.
    const stuck = { ...s, lanes: { ...s.lanes, pulse1: [...s.lanes.pulse1.slice(0, 2), { row: 8, fx: { volume: 3 } }, ...s.lanes.pulse1.slice(2)] } };
    expect(ok(setEffect(stuck, 'pulse1', 8, undefined, [])).song.lanes.pulse1).toEqual(s.lanes.pulse1);
  });

  it('changes or removes a cutTick', () => {
    const s = song({ lanes: { pulse1: [{ row: 0, len: 1, note: 'C5', inst: 1, cutTick: 2 }] } });
    const note = s.lanes.pulse1[0]!;
    const r = ok(setCutTick(s, 'pulse1', note, 4, [note]));
    expect(r.song.lanes.pulse1[0]).toEqual({ ...note, cutTick: 4 });
    expect(r.selection).toEqual([r.song.lanes.pulse1[0]]);
    expect(ok(setCutTick(s, 'pulse1', note, undefined, [])).song.lanes.pulse1[0]).not.toHaveProperty('cutTick');
  });

  // Issue 8: a cutTick added to a note without one takes its last row's effect slot, and fits that row's ticks.
  it('adds a cutTick where the last row is free and the tick fits', () => {
    const s = song({ global: [{ row: 3, tempo: 3 }] });
    const note = s.lanes.pulse1[0]!; // C5, rows 0 to 3
    const r = ok(setCutTick(s, 'pulse1', note, 2, [note]));
    expect(r.song.lanes.pulse1[0]).toEqual({ ...note, cutTick: 2 });
    expect(r.selection).toEqual([r.song.lanes.pulse1[0]]);
    expect(compile(r.song).ok).toBe(true);
    // Row 3 has 3 ticks at tempo 3.
    expect(setCutTick(s, 'pulse1', note, 3, [])).toBe("cut tick 3 doesn't fit at 1.1.4, which has 3 ticks");
    // An effect on the last row is in the way, the note's own on a one-row note too.
    const fx = ok(setEffect(s, 'pulse1', 3, { vibrato: [4, 2] }, [])).song;
    expect(setCutTick(fx, 'pulse1', fx.lanes.pulse1[0]!, 1, [])).toBe(
      "Vibrato speed 4, depth 2 is on the note's last row, at 1.1.4, and a cut there needs its effect slot; remove it first",
    );
    const one = song({ lanes: { pulse1: [{ row: 0, len: 1, note: 'C5', inst: 1, fx: { volume: 8 } }] } });
    expect(setCutTick(one, 'pulse1', one.lanes.pulse1[0]!, 1, [])).toMatch(/^Volume 8 is on the note's last row/);
  });

  it("gives a drawn note the effect on its row, but not a cut or over its own", () => {
    const s = ok(setEffect(song(), 'pulse1', 12, { vibrato: [4, 2] }, [])).song;
    const drawn = draw(s, 'pulse1', { row: 12, len: 2, note: 'G5', inst: 1 });
    expect(drawn.song.lanes.pulse1.filter((i) => i.row === 12)).toEqual([{ row: 12, len: 2, note: 'G5', inst: 1, fx: { vibrato: [4, 2] } }]);
    expect(drawn.selection).toEqual([drawn.song.lanes.pulse1[2]]);
    const own = draw(s, 'pulse1', { row: 12, len: 2, note: 'G5', inst: 1, fx: { volume: 4 } });
    expect(own.song.lanes.pulse1[2]!.fx).toEqual({ volume: 4 });
    const cut = ok(setEffect(song(), 'pulse1', 12, { cut: 1 }, [])).song;
    expect(draw(cut, 'pulse1', { row: 12, len: 2, note: 'G5', inst: 1 }).song.lanes.pulse1[2]).not.toHaveProperty('fx');
  });

  it('reads ticks, tempo and effects as people would', () => {
    const groove = song({ groove: [6, 5, 6, 5] });
    expect([ticksAt(groove, 1), ticksAt(groove, 2)]).toEqual([5, 6]);
    // A tempo lasts through the loop, so a row before it plays faster the second time: the fewest ticks count.
    expect(ticksAt(song({ global: [{ row: 8, tempo: 3 }] }), 1)).toBe(3);
    expect(ticksAt(song({ global: [{ row: 0, tempo: 6 }, { row: 8, tempo: 3 }] }), 1)).toBe(6);
    expect(bpm(6, 4, 60)).toBe(150);
    expect(longEffect({ vibrato: [4, 2] })).toBe('Vibrato speed 4, depth 2');
    expect(longEffect({ arp: [4, 7] })).toBe('Arpeggio +4, +7');
  });
});

// Issue 7: effects selected, moved and copied apart from their notes, and volume drawn along the strip.
describe('effects apart from their notes', () => {
  const lane = (more: object[]) =>
    song({
      lanes: {
        pulse1: [
          { row: 0, len: 4, note: 'C5', inst: 1, fx: { volume: 9 } }, // cut at 4
          { row: 2, fx: { vibrato: [4, 2] } },
          { row: 8, len: 2, note: 'E5', inst: 1 }, // cut at 10
          ...more,
        ],
      },
    });

  it("reads the effects on rows, a note's or an item's", () => {
    expect(effectsOn(lane([]), 'pulse1', [8, 2, 0, 5])).toEqual([
      { row: 0, fx: { volume: 9 } },
      { row: 2, fx: { vibrato: [4, 2] } },
    ]);
  });

  it('deletes effects and leaves their notes', () => {
    const s = lane([]);
    const r = ok(removeEffects(s, 'pulse1', [0, 2]));
    expect(r.song.lanes.pulse1).toEqual([{ row: 0, len: 4, note: 'C5', inst: 1 }, s.lanes.pulse1[2]]);
    expect(r.effects).toEqual([]);
  });

  it("moves effects off a note's row and onto another's, replacing what's there", () => {
    const s = lane([{ row: 12, fx: { slideUp: 3 } }]);
    // The note's volume becomes an item without a note; the vibrato lands on E5's row and becomes its fx.
    const r = ok(moveEffects(s, 'pulse1', [0, 2], 6));
    expect(r.song.lanes.pulse1).toEqual([
      { row: 0, len: 4, note: 'C5', inst: 1 },
      { row: 6, fx: { volume: 9 } },
      { row: 8, len: 2, note: 'E5', inst: 1, fx: { vibrato: [4, 2] } },
      { row: 12, fx: { slideUp: 3 } },
    ]);
    expect(r.effects).toEqual([6, 8]);
    expect(compile(r.song).ok).toBe(true);
    // Landing on another effect replaces it.
    const over = ok(moveEffects(s, 'pulse1', [2], 10)).song.lanes.pulse1;
    expect(over.filter((i) => i.row === 12)).toEqual([{ row: 12, fx: { vibrato: [4, 2] } }]);
  });

  // The issue: a move has to respect the rows a note's end needs.
  it("won't move an effect onto a row a note's end needs, a cut into a note, or out of the song", () => {
    const s = lane([{ row: 12, fx: { cut: 1 } }]);
    expect(moveEffects(s, 'pulse1', [2], 2)).toMatch(/note at 1\.1\.1 ends here and its cut needs/);
    expect(moveEffects(s, 'pulse1', [2], 8)).toMatch(/1\.3\.1 ends here/);
    expect(moveEffects(s, 'pulse1', [12], -3)).toMatch(/cut inside a note/);
    expect(moveEffects(s, 'pulse1', [0, 2], -1)).toMatch(/start of the song/);
    expect(moveEffects(s, 'pulse1', [12], 4)).toMatch(/end of the song/);
    expect(moveEffects(s, 'pulse1', [5], 1)).toMatch(/select some effects/);
  });

  // A cut moved to a row with fewer ticks never happens.
  it("won't move a delay or cut past its new row's ticks", () => {
    const s = song({ groove: [6, 3, 6, 3], lanes: { pulse1: [{ row: 12, fx: { cut: 5 } }, { row: 14, fx: { delay: 5 } }] } });
    expect(moveEffects(s, 'pulse1', [12], 1)).toMatch(/cut 5 doesn't fit at 1\.4\.2, which has 3 ticks/);
    expect(moveEffects(s, 'pulse1', [14], -1)).toMatch(/delay 5 doesn't fit/);
    expect(ok(moveEffects(s, 'pulse1', [12, 14], -2)).effects).toEqual([10, 12]);
  });

  it('copies, pastes and duplicates effects, without their notes', () => {
    const s = lane([]);
    const clip = copyEffects(s, 'pulse1', [0, 2])!;
    expect(clip).toEqual({ effects: [{ row: 0, fx: { volume: 9 } }, { row: 2, fx: { vibrato: [4, 2] } }], span: 3 });
    const r = ok(pasteEffects(s, 'pulse1', clip, 11));
    expect(r.song.lanes.pulse1.slice(3)).toEqual([{ row: 11, fx: { volume: 9 } }, { row: 13, fx: { vibrato: [4, 2] } }]);
    expect(r.effects).toEqual([11, 13]);
    expect(pasteEffects(s, 'pulse1', clip, 14)).toMatch(/isn't room/);
    expect(pasteEffects(s, 'pulse1', clip, 8)).toMatch(/ends here/); // the vibrato would land on E5's cut
    // Pasted on a lane that can't play it, refused, as the compiler would.
    const duty = { effects: [{ row: 0, fx: { duty: '25%' as const } }], span: 1 };
    expect(pasteEffects(s, 'wave', duty, 0)).toMatch(/duty only works on pulse lanes/);
  });

  it("draws volume where a note starts or a volume is, leaving other effects and notes' ends", () => {
    const s = lane([{ row: 12, fx: { volume: 2 } }, { row: 13, len: 1, note: 'G5', inst: 1, cutTick: 1 }]);
    const sel = [s.lanes.pulse1[0]!];
    const volumes = new Map([0, 1, 2, 4, 8, 12, 13].map((row) => [row, 5]));
    const r = drawVolume(s, 'pulse1', volumes, sel);
    expect(effectsOn(r.song, 'pulse1', volumes.keys())).toEqual([
      { row: 0, fx: { volume: 5 } }, // the note's volume, changed
      { row: 2, fx: { vibrato: [4, 2] } }, // another effect keeps its slot
      { row: 8, fx: { volume: 5 } }, // a note without one gets one
      { row: 12, fx: { volume: 5 } }, // a volume without a note, changed
    ]); // not row 1 (empty), 4 (C5's cut) or 13 (G5's cutTick)
    expect(r.selection).toEqual([r.song.lanes.pulse1[0]]);
    expect(compile(r.song).ok).toBe(true);
    // A stroke over empty rows, or one that sets what's there, was an edit, and lost the redo.
    expect(drawVolume(s, 'pulse1', new Map([[1, 5], [0, 9]]), sel).song).toBe(s);
  });
});

describe('song-wide effects', () => {
  it('sets, changes and clears a row, keeping other rows and the formatter’s order', () => {
    const s = song({ global: [{ row: 0, tempo: 6 }, { row: 8, tempo: 3 }] });
    const r = ok(setGlobal(s, 4, { masterVolume: [7, 3], tempo: 4 }));
    expect(r.global).toEqual([
      { row: 0, tempo: 6 },
      { row: 4, tempo: 4 },
      { row: 4, masterVolume: [7, 3] },
      { row: 8, tempo: 3 },
    ]);
    expect(globalAt(r, 4)).toEqual({ tempo: 4, masterVolume: [7, 3] });
    expect(ok(setGlobal(r, 4, {})).global).toEqual(s.global);
    expect(compile(r).ok).toBe(true);
    expect(setGlobal(s, 16, { tempo: 1 })).toMatch(/isn't in the song/);
  });
});
