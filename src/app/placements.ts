import { position } from '../core/location.ts';
import { expand, fittingItems, occurrenceAt, placementSpan, type Occurrence } from '../core/patterns.ts';
import type { LaneItem, LaneName, PatternItem, Song } from '../core/schema.ts';
import { project, transposable, unproject } from './arrange.ts';
import { endRows } from './effects.ts';

// Edits to a lane's notes and effects (edit.ts, effects.ts) know nothing of patterns. They get the song without the
// lane's placements, and the placements go back after, unless the edit put something in the rows one has to itself
// (docs/patterns/, "Loose notes around them").

/** The song without a lane's placements, and a function that puts them back into an edited version of it, or says
 * why it can't: the edit put something in a placement's rows, ran a note into them, or put an effect where a
 * pattern's note ends and needs the slot for its cut. Only items the edit added or changed are checked, so a song
 * that already breaks the rule can still be edited elsewhere. */
export function withoutPlacements(song: Song, lane: LaneName): { song: Song; restore: (edited: Song) => Song | string } {
  const placements = song.lanes[lane].filter((i) => i.pattern !== undefined);
  if (!placements.length) return { song, restore: (edited) => edited };
  const loose = song.lanes[lane].filter((i) => i.pattern === undefined);
  const bare = { ...song, lanes: { ...song.lanes, [lane]: loose } };
  const before = new Set(loose);
  return {
    song: bare,
    restore: (edited) => {
      const patterns = new Map((edited.patterns ?? []).map((p) => [p.id, p]));
      const spans = placements.map((p) => {
        const pattern = patterns.get(p.pattern!);
        return { id: p.pattern!, start: p.row, end: p.row + (pattern ? placementSpan(p, pattern) : 1) };
      });
      const at = (row: number) => position(song.grid, row);
      for (const item of edited.lanes[lane]) {
        if (before.has(item)) continue;
        const inside = spans.find((s) => item.row >= s.start && item.row < s.end);
        if (inside) return `pattern ${inside.id} plays there (from ${at(inside.start)}), and loose notes can't go in it`;
        const end = item.row + (item.len ?? 1);
        const into = item.note === undefined ? undefined : spans.find((s) => s.start > item.row && s.start < end);
        if (into) return `the note would run into pattern ${into.id}, which plays from ${at(into.start)}`;
      }
      const items: LaneItem[] = [...edited.lanes[lane], ...placements].sort((a, b) => a.row - b.row);
      const result = { ...edited, lanes: { ...edited.lanes, [lane]: items } };
      const { song: flat, occurrences } = expand(result);
      const ends = endRows(flat, lane);
      for (const item of edited.lanes[lane]) {
        const ender = before.has(item) || item.note !== undefined ? undefined : ends.get(item.row);
        const o = ender && occurrenceAt(occurrences, lane, ender.row);
        if (o) return `${ender!.note} in pattern ${o.pattern.id} ends at ${at(item.row)}, and its cut needs that row's effect slot`;
      }
      return result;
    },
  };
}

/** The target of edits when it's a place a pattern plays (docs/patterns/, "Editing notes"). */
export interface Opened {
  lane: LaneName;
  start: number; // the row this occurrence starts at: a repeat's own start, for a placement that repeats
  id: string;
}

/** The occurrence a song has for the target, if it still has it whole: a repeat cut short can't be the target. */
export function occurrenceOf(song: Song, o: Opened): Occurrence | undefined {
  return expand(song).occurrences.find((x) => x.lane === o.lane && x.start === o.start && x.pattern.id === o.id && x.length === x.pattern.length);
}

// Views by source song and what's open. An edit stores its result's view against the new source song, so the
// notes it selected are the ones the roll draws next.
const views = new WeakMap<Song, Map<string, Song>>();
const viewKey = (o: Opened) => `${o.lane}\0${o.start}\0${o.id}`;

function remember(song: Song, o: Opened, view: Song) {
  let m = views.get(song);
  if (!m) views.set(song, (m = new Map()));
  m.set(viewKey(o), view);
}

/** The song as the roll shows it with a pattern open: the occurrence's notes and effects as items of the lane, at
 * the rows and pitches they play, and the rest of its placement's repeats placed either side. Nothing else changes,
 * so it plays the same. */
export function openView(song: Song, o: Opened): Song | undefined {
  const known = views.get(song)?.get(viewKey(o));
  if (known) return known;
  const occ = occurrenceOf(song, o);
  if (!occ) return undefined;
  const p = occ.placement;
  const repeats = p.repeat ?? 1;
  const len = occ.pattern.length;
  const part = (row: number, repeat: number, cut?: number): LaneItem => {
    const { repeat: _, len: __, ...rest } = p;
    return { ...rest, row, ...(repeat > 1 && { repeat }), ...(cut !== undefined && { len: cut }) };
  };
  const parts: LaneItem[] = [];
  if (occ.repeat > 0) parts.push(part(p.row, occ.repeat));
  // The repeats after it, the last cut short as the placement's len cuts it.
  if (occ.repeat < repeats - 1) parts.push(part(occ.start + len, repeats - 1 - occ.repeat, p.len === undefined ? undefined : p.row + p.len - occ.start - len));
  const own = fittingItems(occ.pattern).map((i) => project(i, occ.start, p.transpose ?? 0));
  const items = [...song.lanes[o.lane].filter((i) => i !== p), ...parts, ...own].sort((a, b) => a.row - b.row);
  const view = { ...song, lanes: { ...song.lanes, [o.lane]: items } };
  remember(song, o, view);
  return view;
}

/** Keeps the open pattern's view, and so its selected notes, across an edit that changes neither lanes nor
 * patterns, such as to an instrument. */
export function carryView(before: Song, after: Song, o: Opened) {
  const view = views.get(before)?.get(viewKey(o));
  if (view && after.lanes === before.lanes && after.patterns === before.patterns) remember(after, o, { ...after, lanes: view.lanes });
}

/** What an edit to the expanded lane works on, and a function that turns its result back into the source song, or
 * says why it can't. With a pattern open in the lane, that's the open occurrence's items, written back to the
 * pattern; otherwise the lane without its placements. */
export function editView(
  song: Song,
  lane: LaneName,
  opened: Opened | undefined,
): { song: Song; restore: (edited: Song) => Song | string } {
  const occ = opened && opened.lane === lane ? occurrenceOf(song, opened) : undefined;
  const view = occ && openView(song, opened!);
  if (!occ || !view) return withoutPlacements(song, lane);
  const o = opened!;
  const start = occ.start;
  const end = start + occ.pattern.length;
  const transpose = occ.placement.transpose ?? 0;
  const ours = (i: LaneItem) => i.pattern === undefined && i.row >= start && i.row < end;
  const own = view.lanes[lane].filter(ours);
  const others = view.lanes[lane].filter((i) => !ours(i));
  const before = new Set(own);
  const at = (row: number) => position(song.grid, row);
  // A note this place's transpose takes out of C3–B8 is shown as it is in the pattern, so the view can't be turned
  // back into the pattern; the song doesn't compile like that either. Its edits wait for the transpose to change.
  const stuck = fittingItems(occ.pattern).find((i) => !transposable(i, transpose));
  if (stuck) {
    const why = `${stuck.note} in pattern ${o.id} goes out of C3–B8 when this place transposes it by ${transpose > 0 ? '+' : ''}${transpose}; change the transpose first`;
    return { song: { ...view, lanes: { ...view.lanes, [lane]: own } }, restore: () => why };
  }
  return {
    song: { ...view, lanes: { ...view.lanes, [lane]: own } },
    restore: (edited) => {
      const items = edited.lanes[lane];
      const back: PatternItem[] = [];
      for (const item of items) {
        if (!before.has(item)) {
          if (item.row < start || item.row >= end) {
            return `notes in pattern ${o.id} stay between ${at(start)} and ${at(end)}, where this place plays it`;
          }
          if (item.note !== undefined && item.row + (item.len ?? 1) > end) {
            return `the note would run past the end of pattern ${o.id}, at ${at(end)}`;
          }
        }
        const b = unproject(item, start, transpose);
        if (typeof b === 'string') return b;
        back.push(b);
      }
      const unfit = occ.pattern.items.filter((i) => !fittingItems(occ.pattern).includes(i)); // errors, kept as they were
      const pattern = { ...occ.pattern, items: [...back, ...unfit].sort((a, b) => a.row - b.row) };
      const next: Song = {
        ...edited,
        lanes: song.lanes,
        patterns: song.patterns!.map((p) => (p === occ.pattern ? pattern : p)),
      };
      remember(next, o, { ...next, lanes: { ...song.lanes, [lane]: [...others, ...items].sort((a, b) => a.row - b.row) } });
      return next;
    },
  };
}
