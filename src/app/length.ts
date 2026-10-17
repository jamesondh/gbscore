import { rangeErrors } from '../core/compile.ts';
import { placementSpan } from '../core/patterns.ts';
import { LANES, type LaneItem, type Song } from '../core/schema.ts';
import { isNote, noteEnd, shorten } from './edit.ts';

// The song's length and the row it loops back to (docs/editor/, "Length and loop"). A shorter song cuts what's
// past its new end, as one step of undo, rather than refusing until it's cleared by hand.

/** What a new end cut: items that started past it, and notes and placements shortened to end there. */
export interface Cut {
  notes: number;
  effects: number; // in lanes and the song lane
  placements: number;
  shortened: number;
}

export type Ranged = { song: Song; cut: Cut; loopReset: boolean } | string;

/** Sets the song's length and the row it loops back to. Without a loop given, a loop at or past the new end goes
 * back to row 0, the only row sure to be left. */
export function setRange(song: Song, length: number, loop?: number): Ranged {
  if (!Number.isInteger(length) || length < 1) return 'the length is a whole number of rows, 1 or more';
  if (loop !== undefined && (!Number.isInteger(loop) || loop < 0)) return 'the loop is a whole number of rows, 0 or more';
  const loopReset = loop === undefined && song.loop >= length;
  const next = loop ?? (loopReset ? 0 : song.loop);
  const why = rangeErrors({ length, loop: next, groove: song.groove })[0];
  if (why) return why.message;
  const cut: Cut = { notes: 0, effects: 0, placements: 0, shortened: 0 };
  if (length === song.length && next === song.loop) return { song, cut, loopReset };
  if (length >= song.length) return { song: { ...song, length, loop: next }, cut, loopReset };

  const patterns = new Map((song.patterns ?? []).map((p) => [p.id, p]));
  let lanes = song.lanes;
  for (const lane of LANES) {
    const items: LaneItem[] = [];
    let changed = false;
    for (const item of song.lanes[lane]) {
      const p = item.pattern === undefined ? undefined : patterns.get(item.pattern);
      if (item.row >= length) {
        changed = true;
        if (item.pattern !== undefined) cut.placements++;
        else if (isNote(item)) cut.notes++;
        else cut.effects++;
      } else if (p && item.row + placementSpan(item, p) > length) {
        // As dragging its right edge to the end does: whole repeats, and len for a last one cut short.
        const rows = length - item.row;
        const { repeat: _, len: __, ...rest } = item;
        const repeat = Math.ceil(rows / p.length);
        items.push({ ...rest, ...(repeat > 1 && { repeat }), ...(rows % p.length !== 0 && { len: rows }) });
        changed = true;
        cut.shortened++;
      } else if (isNote(item) && noteEnd(item) > length) {
        items.push(shorten(item, length - item.row));
        changed = true;
        cut.shortened++;
      } else items.push(item);
    }
    if (changed) lanes = { ...lanes, [lane]: items };
  }
  const global = song.global.filter((g) => g.row < length);
  cut.effects += song.global.length - global.length;
  return {
    song: { ...song, length, loop: next, lanes, global: global.length === song.global.length ? song.global : global },
    cut,
    loopReset,
  };
}

/** What a cut took, as "3 notes and an effect cut, 1 note shortened", or nothing if it took nothing. */
export function describeCut(cut: Cut): string {
  const count = (n: number, what: string) => (n === 1 ? `${what === 'effect' ? 'an' : 'a'} ${what}` : `${n} ${what}s`);
  const gone = [
    cut.notes && count(cut.notes, 'note'),
    cut.effects && count(cut.effects, 'effect'),
    cut.placements && count(cut.placements, 'placed pattern'),
  ].filter((s): s is string => !!s);
  const parts = [];
  if (gone.length) parts.push(`${gone.length > 1 ? `${gone.slice(0, -1).join(', ')} and ${gone.at(-1)}` : gone[0]} cut`);
  if (cut.shortened) parts.push(`${cut.shortened} shortened to end there`);
  return parts.join(', ');
}
