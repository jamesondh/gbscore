import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { expect } from 'vitest';
import { loadAssets } from '../src/cli/assets.ts';
import { compile } from '../src/core/compile.ts';
import { walk, type DriverSong } from '../src/core/driver.ts';
import type { Song } from '../src/core/schema.ts';
import { formatLog } from '../src/play/log.ts';
import { render, type Rendering } from '../src/play/render.ts';
import { expectedTicks } from './model.ts';

// Plays songs on the emulator for test/play.test.ts, and the tests in test/private/.

export const assets = await loadAssets();

export function compiled(song: Song) {
  const c = compile(song);
  if (!c.ok) throw new Error(c.errors.map((e) => e.message).join('\n'));
  return c;
}

/** The rows the emulator played, each with the ticks it lasted. */
export function rowsPlayed(r: Rendering) {
  const rows: { order: number; row: number; ticks: number }[] = [];
  for (const t of r.ticks) {
    if (t.tick === 0) rows.push({ order: t.order, row: t.row, ticks: 0 });
    rows.at(-1)!.ticks++;
  }
  return rows;
}

/** Plays the song through once and on for up to 64 rows past the loop, then checks that the emulator played
 * the timeline in order, and the same rows, for the same ticks, as the driver model in test/model.ts. */
export function checkPlayback(song: Song, data: DriverSong, orderStarts: number[]) {
  const extra = Math.min(64, song.length - song.loop);
  const r = render(assets, data, song, { rows: song.length + extra });
  const played = rowsPlayed(r);
  const timeline = played.map((p) => orderStarts[p.order]! + p.row);
  const expected = [...Array(song.length).keys(), ...Array.from({ length: extra }, (_, i) => song.loop + i)];
  expect(timeline).toEqual(expected);

  const w = walk(data);
  if (typeof w === 'string') throw new Error(w);
  const ticks = expectedTicks(data, w);
  const modelRows = [...w.rows, ...w.rows.slice(w.loop)].map((p, i) => ({ ...p, ticks: ticks[i]! }));
  expect(played).toEqual(modelRows.slice(0, played.length));
  return r;
}

/** Compares a rendering's sound-register writes with a golden log, which GOLDEN=update rewrites. */
export function checkGolden(r: Rendering | undefined, file: URL) {
  if (!r) throw new Error('the playback test for this song failed');
  const log = formatLog(r.startWrites, r.ticks);
  if (process.env.GOLDEN === 'update') writeFileSync(file, gzipSync(log, { level: 9 }));
  expect(existsSync(file), 'no golden file; run GOLDEN=update npm test').toBe(true);
  const golden = gunzipSync(readFileSync(file)).toString('utf8');
  if (log !== golden) {
    const a = log.split('\n');
    const b = golden.split('\n');
    const i = a.findIndex((line, k) => line !== b[k]);
    expect(`line ${i + 1}: ${a[i]}`).toBe(`line ${i + 1}: ${b[i]}`);
  }
}
