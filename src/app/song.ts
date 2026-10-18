import { compile, parseSong } from '../core/compile.ts';
import type { DriverSong } from '../core/driver.ts';
import type { SongError } from '../core/location.ts';
import { parseNote } from '../core/notes.ts';
import type { Song } from '../core/schema.ts';

/** What the emulator needs to play a song from a row. */
export interface Playable {
  data: DriverSong;
  orderStarts: number[];
  length: number;
  size: number; // the compiled song's bytes
}

export interface Loaded {
  song?: Song; // absent if the file isn't a valid song
  errors: SongError[];
  playable?: Playable; // absent if it doesn't compile
}

/** Reads a song file's text: parses it, checks it and compiles it. */
export function load(text: string): Loaded {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { errors: [{ message: `the file isn't valid JSON: ${e instanceof Error ? e.message : e}` }] };
  }
  const parsed = parseSong(json);
  if (parsed.errors) return { errors: parsed.errors };
  return { song: parsed.song, ...check(parsed.song) };
}

/** Compiles a song. */
export function check(song: Song): { errors: SongError[]; playable?: Playable } {
  const c = compile(song);
  if (!c.ok) return { errors: c.errors };
  return { errors: [], playable: { data: c.data, orderStarts: c.layout.orderStarts, length: song.length, size: c.size } };
}

/** A note name's index, C3 = 0. Names the schema accepts but the compiler rejects count as C3. */
export function noteIndex(name: string): number {
  const n = parseNote(name);
  return typeof n === 'number' ? n : 0;
}
