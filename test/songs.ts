import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { duplicate, isNote, move, remove } from '../src/app/edit.ts';
import { compile, parseSong } from '../src/core/compile.ts';
import type { DriverSong } from '../src/core/driver.ts';
import { exportGbdk } from '../src/core/export.ts';
import { formatSong } from '../src/core/format.ts';
import { importUge } from '../src/core/import.ts';
import { expand } from '../src/core/patterns.ts';
import { LANE_KIND, LANES, type LaneItem, type Pattern, type Song } from '../src/core/schema.ts';
import { readReference } from './reference.ts';

// The test songs, and the checks the tests make on a whole song. Tests on songs that can't be redistributed live
// with them in test/private/ (test/fixtures/README.md) and make the same checks.

/** A file in test/fixtures/: `fixture('halt_bug.uge')`. */
export const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

/** The editor's demo song, HALT Bug: duty, wave and noise instruments, slides, patterns and tempo changes. */
export function demoSong(): Song {
  return parse(readFileSync(new URL('../src/app/demo/halt_bug.gbscore.json', import.meta.url), 'utf8'));
}

function parse(text: string): Song {
  const p = parseSong(JSON.parse(text));
  if (p.errors) throw new Error(JSON.stringify(p.errors));
  return p.song;
}

/** Checks a song compiles, but for errors it had before. */
export function compiles(s: Song, before: Song | undefined = undefined) {
  const errors = (s: Song) => {
    const c = compile(s, { budget: Infinity });
    return c.ok ? [] : c.errors.map((e) => e.message);
  };
  const known = new Set(before ? errors(before) : []);
  expect(errors(s).filter((e) => !known.has(e))).toEqual([]);
}

/** Formatting the song, then reading it back, gives the same text and compiles the same. */
export function survivesRoundTrip(song: Song) {
  const text = formatSong(song);
  const reread = parse(text);
  expect(formatSong(reread)).toBe(text);
  expect(compile(reread)).toEqual(compile(song));
}

/** Pattern numbering is each writer's own, so compare what each order plays. */
const ordersPlay = (d: DriverSong) => ({ ...d, patterns: [], orders: d.orders.map((o) => o.map((p) => d.patterns[p])) });

/** export --gbdk's C, read back as uge2source's is, gives the compiled song. */
export function readsBack(data: DriverSong) {
  const file = join(mkdtempSync(join(tmpdir(), 'gbscore-export-')), 'song.c');
  writeFileSync(file, exportGbdk(data, { name: 'song_uge', bank: 255 }));
  expect(ordersPlay(readReference(file))).toEqual(ordersPlay(data));
}

/** A lane's items cut into chunks of `size` rows, each chunk that no note crosses into or out of becoming a
 * pattern, identical chunks sharing one and runs of the same chunk becoming one placement with repeat. */
function factor(s: Song, size: number): Song {
  const patterns = new Map<string, Pattern>();
  const out = {} as Song['lanes'];
  for (const lane of LANES) {
    const items = s.lanes[lane];
    const crosses = (row: number) => items.some((i) => i.note !== undefined && i.row < row && i.row + (i.len ?? 1) > row);
    const result: LaneItem[] = [];
    let last: LaneItem | undefined;
    for (let start = 0; start < s.length; start += size) {
      const end = Math.min(start + size, s.length);
      const inside = items.filter((i) => i.row >= start && i.row < end);
      if (!inside.length || crosses(start) || crosses(end)) {
        result.push(...inside);
        last = undefined;
        continue;
      }
      const rel = inside.map((i) => ({ ...i, row: i.row - start }));
      const key = `${LANE_KIND[lane]}:${end - start}:${JSON.stringify(rel)}`;
      let p = patterns.get(key);
      if (!p) {
        p = { id: `p${patterns.size}`, kind: LANE_KIND[lane], length: end - start, items: rel };
        patterns.set(key, p);
      }
      if (last?.pattern === p.id && last.row + (last.repeat ?? 1) * p.length === start) last.repeat = (last.repeat ?? 1) + 1;
      else result.push((last = { row: start, pattern: p.id }));
    }
    out[lane] = result;
  }
  return { ...s, patterns: [...patterns.values()], lanes: out };
}

/** A song without patterns, factored into 16-row patterns, compiles to the same bytes. */
export function factorsIntoPatterns(flat: Song) {
  const factored = factor(flat, 16);
  expect(factored.patterns!.length).toBeGreaterThan(0);
  // Through the file, as an agent's edit would arrive.
  const reread = parse(formatSong(factored));
  expect(expand(reread).song.lanes).toEqual(parse(formatSong(flat)).lanes);
  expect(compile(reread)).toEqual(compile(flat));
}

/** A .uge imported with its hUGE patterns compiles to the same bytes as imported without. */
export function importsWithPatterns(bytes: Uint8Array) {
  const flat = importUge(bytes);
  const placed = importUge(bytes, { patterns: true });
  const reread = parse(formatSong(placed.song));
  expect(expand(reread).errors).toEqual([]);
  expect(expand(reread).song.lanes).toEqual(parse(formatSong(flat.song)).lanes);
  const compiled = compile(reread, { budget: Infinity });
  // A song that imports with errors gets them again, saying which pattern they're in.
  if (flat.errors.length) expect(placed.errors).toEqual(compiled.ok ? [] : compiled.errors);
  else expect(compiled).toEqual(compile(flat.song, { budget: Infinity }));
}

/** A song without patterns still compiles after moving, duplicating and deleting notes in every lane. */
export function compilesAfterEdits(start: Song) {
  const ok = <T,>(r: T | string) => {
    if (typeof r === 'string') throw new Error(r);
    return r;
  };
  let s = start;
  for (const lane of LANES) {
    const first = s.lanes[lane].filter((i) => isNote(i) && i.row < 64);
    if (!first.length) continue;
    s = remove(s, lane, first.slice(0, 3)).song;
    const rest = s.lanes[lane].filter((i) => isNote(i) && i.row >= 64 && i.row < 128);
    s = ok(move(s, lane, rest, 3, 0)).song;
    s = ok(duplicate(s, lane, s.lanes[lane].filter((i) => isNote(i) && i.row >= 256 && i.row < 320))).song;
  }
  compiles(s, start);
}
