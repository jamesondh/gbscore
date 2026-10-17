import { describe, expect, it } from 'vitest';
import { parseSong } from '../src/core/compile.ts';
import { assemble, songSize } from '../src/core/driver.ts';
import type { Song, SongInput } from '../src/core/schema.ts';
import { Playback, SONG_ADDRESS, TICK_LENGTH } from '../src/play/player.ts';
import { render, RenderTooLong, type Rendering } from '../src/play/render.ts';
import { encodeWav } from '../src/play/wav.ts';
import { assets, checkGolden, checkPlayback, compiled, rowsPlayed } from './playback.ts';
import { demoSong } from './songs.ts';

// Pass 2's acceptance (docs/editor/, "Passes"): the songs play on binjgb running the pinned driver, at the
// game's tick rate, the way the compiler and the driver model say they do.

function parsed(input: SongInput): Song {
  const p = parseSong(input);
  if (p.errors) throw new Error(JSON.stringify(p.errors));
  return p.song;
}

// halt_bug is the editor's demo song. test/private/ plays more songs the same way.
const songs: Record<string, () => Song> = { halt_bug: demoSong };
const renderings = new Map<string, Rendering>();

// A three-minute song takes about 4 s to play on the emulator.
describe('the emulator plays what the compiler laid out', { timeout: 30_000 }, () => {
  it.each(Object.keys(songs))('%s', (name) => {
    const song = songs[name]!();
    const c = compiled(song);
    renderings.set(name, checkPlayback(song, c.data, c.layout.orderStarts));
  });

  it.each([
    [100, 0],
    [200, 40],
    [128, 64],
    [130, 129],
  ])('length %i, looping to row %i', (length, loop) => {
    const song = parsed({
      version: 1,
      grid: { rowsPerBeat: 4, beatsPerBar: 4 },
      groove: [2, 2, 2, 2],
      length,
      loop,
      instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
      lanes: { pulse1: [{ row: 0, len: length, note: 'C5', inst: 1 }] },
    });
    const c = compiled(song);
    checkPlayback(song, c.data, c.layout.orderStarts);
  });

  it('a song over one 16 KB bank', () => {
    // A note on every row of every lane, stepping through the notes at a different rate in each lane and from a
    // different note in each order, so no pattern repeats: 24 orders of 4 × 192 bytes. The player used to hold only 16 KB.
    const names = [3, 4, 5, 6].flatMap((octave) => [...'CDEFGAB'].map((n) => `${n}${octave}`));
    const length = 24 * 64;
    const lane = (inst: number, step: number) =>
      Array.from({ length }, (_, row) => ({ row, len: 1, note: names[(row * step + (row >> 6) * 3) % names.length]!, inst }));
    const song = parsed({
      version: 1,
      grid: { rowsPerBeat: 4, beatsPerBar: 4 },
      groove: [1, 1, 1, 1],
      length,
      instruments: {
        duty: [{ id: 1, duty: '50%', volume: 15 }],
        wave: [{ id: 1, wave: 0, level: '100%' }],
        noise: [{ id: 1, volume: 15 }],
      },
      waves: [{ id: 0, data: '0123456789ABCDEFFEDCBA9876543210' }],
      lanes: { pulse1: lane(1, 1), pulse2: lane(1, 3), wave: lane(1, 5), noise: lane(1, 9) },
    });
    const c = compiled(song);
    expect(c.size).toBeGreaterThan(16384);
    checkPlayback(song, c.data, c.layout.orderStarts);
  });
});

describe('tempo', () => {
  it('an Fxx on every row, alternating 4 and 3, plays each row for the ticks its own Fxx says', () => {
    const length = 16;
    const song = parsed({
      version: 1,
      grid: { rowsPerBeat: 4, beatsPerBar: 4 },
      groove: [5, 5, 5, 7],
      length,
      instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
      lanes: { pulse1: [{ row: 0, len: length, note: 'C5', inst: 1 }] },
      global: Array.from({ length }, (_, row) => ({ row, tempo: row % 2 ? 3 : 4 })),
    });
    const c = compiled(song);
    const r = checkPlayback(song, c.data, c.layout.orderStarts);
    expect(rowsPlayed(r).map((p) => p.ticks)).toEqual(Array.from({ length: length * 2 }, (_, i) => (i % 2 ? 3 : 4)));
    renderings.set('alternating tempo', r);
  });

  it('a tempo change makes a swung groove uniform from its row, and it stays uniform after the loop', () => {
    const song = parsed({
      version: 1,
      grid: { rowsPerBeat: 4, beatsPerBar: 4 },
      groove: [5, 5, 5, 7],
      length: 16,
      instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
      lanes: { pulse1: [{ row: 0, len: 16, note: 'C5', inst: 1 }] },
      global: [{ row: 8, tempo: 3 }],
    });
    const c = compiled(song);
    const ticks = rowsPlayed(render(assets, c.data, song, { loops: 2 })).map((r) => r.ticks);
    expect(ticks).toEqual([5, 5, 5, 7, 5, 5, 5, 7, ...Array(8).fill(3), ...Array(16).fill(3)]);
  });
});

// The sound-register writes, tick by tick, for one pass and up to 64 rows past the loop. A change to the driver,
// the player, the emulator or the compiler's output shows up here. GOLDEN=update rewrites them.
describe('sound-register logs match the golden files', () => {
  it.each(Object.keys(songs))('%s', (name) => {
    checkGolden(renderings.get(name), new URL(`./golden/${name}.apu.gz`, import.meta.url));
  });
});

describe('rendering', () => {
  it('lays the song out at the address the player reads it from', () => {
    const c = compiled(demoSong());
    const bytes = assemble(c.data, SONG_ADDRESS);
    expect(bytes.length).toBe(songSize(c.data));
    expect([...bytes.slice(0, 5)]).toEqual([6, 6, 6, 6, 26]); // the groove, then 13 orders × 2
    const order1 = bytes[5]! | (bytes[6]! << 8);
    expect(order1).toBe(SONG_ADDRESS + 23); // the orders follow the 23-byte header
  });

  it("stops before the next tick, even when the driver's ticks run long", () => {
    // Every channel starts a note with a table on every row, one tick a row: the driver's slowest case.
    const arp: [number, number] = [3, 7];
    const table = [{ note: 12, fx: { arp } }, { note: -12, jump: 1 }];
    const lane = (inst: number) => Array.from({ length: 8 }, (_, row) => ({ row, len: 1, note: row % 2 ? 'C5' : 'G5', inst }));
    const song = parsed({
      version: 1,
      grid: { rowsPerBeat: 4, beatsPerBar: 4 },
      groove: [1, 1, 1, 1],
      length: 8,
      instruments: {
        duty: [{ id: 1, duty: '50%', volume: 15, table }],
        wave: [{ id: 1, wave: 0, level: '100%', table }],
        noise: [{ id: 1, volume: 15, table }],
      },
      waves: [{ id: 0, data: '0123456789ABCDEFFEDCBA9876543210' }],
      lanes: { pulse1: lane(1), pulse2: lane(1), wave: lane(1), noise: lane(1) },
    });
    const p = new Playback(assets, compiled(song).data);
    for (let i = 0; i < 4; i++) p.tick();
    expect(p.finish()).toEqual([]);
    p.delete();
  });

  it('plays on from a snapshot exactly as it played the first time', () => {
    const c = compiled(demoSong());
    const a = new Playback(assets, c.data, { sampleRate: 8000 });
    for (let i = 0; i < 300; i++) a.tick();
    const snapshot = a.snapshot();
    a.takeAudio();
    const straight = Array.from({ length: 200 }, () => a.tick());
    const straightAudio = a.takeAudio();
    const b = new Playback(assets, c.data, { sampleRate: 8000 });
    for (let i = 0; i < 50; i++) b.tick(); // somewhere else first
    b.restore(snapshot);
    const { order, row, tick } = straight[0]!;
    expect(b.upcoming).toEqual({ order, row, tick });
    const resumed = Array.from({ length: 200 }, () => b.tick());
    expect(resumed).toEqual(straight);
    expect(b.takeAudio()).toEqual(straightAudio);
    a.delete();
    b.delete();
  });

  it('leaves muted channels out of the audio only, and plays on as before when they come back', () => {
    const c = compiled(demoSong());
    const run = (p: Playback, ticks: number) => {
      const played = Array.from({ length: ticks }, () => p.tick());
      return { played, audio: p.takeAudio() };
    };
    const a = new Playback(assets, c.data, { sampleRate: 8000 });
    const b = new Playback(assets, c.data, { sampleRate: 8000 });
    a.takeAudio();
    b.takeAudio();
    b.mute([true, false, false, false]);
    const [a1, b1] = [run(a, 200), run(b, 200)];
    expect(b1.played).toEqual(a1.played); // the same writes
    expect(b1.audio).not.toEqual(a1.audio);
    b.mute([false, false, false, false]);
    expect(run(b, 200)).toEqual(run(a, 200));

    // Muting stays across a restore, which a snapshot made unmuted doesn't undo.
    const snapshot = a.snapshot();
    b.mute([true, true, true, true]);
    b.restore(snapshot);
    expect(run(b, 100).audio.every((s) => s === 0)).toBe(true);
    a.delete();
    b.delete();
  });

  it("reports each row's tick count as the driver has it", () => {
    expect(renderings.has('alternating tempo')).toBe(true);
    for (const [name, r] of renderings) {
      const reported = r.ticks.filter((t) => t.tick === 0).map((t) => t.rowTicks);
      expect(reported, name).toEqual(rowsPlayed(r).map((p) => p.ticks));
    }
  });

  it('stops a render that would run too long', () => {
    const song = demoSong();
    expect(() => render(assets, compiled(song).data, song, { loops: 3, maxSeconds: 30 })).toThrow(RenderTooLong);
  });

  it('plays for the length asked for, at 60.24 ticks a second, and writes a WAV of it', () => {
    const song = demoSong();
    const c = compiled(song);
    const r = render(assets, c.data, song, { seconds: 10, sampleRate: 8000 });
    expect(r.ticks.length).toBe(602);
    // A timer one count off would be 0.12 ms a tick out.
    const t = r.ticks;
    expect((t.at(-1)!.time - t[0]!.time) / (t.length - 1)).toBeCloseTo(1 / 60.24, 5);
    // The audio runs from power-on to just before the tick after the last: a tick after the last one started.
    const seconds = r.audio.length / 2 / r.sampleRate;
    expect(seconds).toBeCloseTo(t.at(-1)!.time + TICK_LENGTH / 4194304, 2);
    const wav = encodeWav(r.audio, r.sampleRate);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true)).toBe(r.audio.length * 2);
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
    expect(peak).toBeGreaterThan(1000); // it isn't silent
  });
});
