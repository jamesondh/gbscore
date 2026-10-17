import { LANES, type LaneName } from '../../core/schema.ts';
import type { View } from '../store.ts';

// Where things go on the piano roll. Rows run left to right; in the expanded lane, notes run bottom to top.

export const RULER = 24;
export const GUTTER = 88; // lane names, mute and solo, and the expanded lane's keyboard
export const KEY_LEFT = GUTTER - 32; // where the keyboard starts
export const LANE_BUTTONS = 20; // the top of a lane's mute and solo buttons, below its name
export const LANE_HEADER = 36; // the name and buttons, which the expanded lane's octave names stay under
export const COLLAPSED = 44;
export const STRIP = 24; // the expanded lane's effects, along its bottom
export const CLIPS = 16; // the expanded lane's placed patterns, handled like clips, along its top
export const SONG_LANE = 30; // song-wide effects, under the lanes
export const NOTE_HEIGHT = 12;
export const NOTES = 72; // C3 to B8
export const MIN_ROW_WIDTH = 2;
export const MAX_ROW_WIDTH = 64;

export interface LaneBox {
  lane: LaneName;
  top: number;
  height: number;
  expanded: boolean;
}

export function laneBoxes(height: number, expanded: LaneName): LaneBox[] {
  const big = Math.max(COLLAPSED + STRIP, height - RULER - SONG_LANE - COLLAPSED * (LANES.length - 1));
  let top = RULER;
  return LANES.map((lane) => {
    const box = { lane, top, height: lane === expanded ? big : COLLAPSED, expanded: lane === expanded };
    top += box.height;
    return box;
  });
}

/** The song lane's top: under the last lane. */
export const songLaneTop = (boxes: LaneBox[]) => boxes[boxes.length - 1]!.top + boxes[boxes.length - 1]!.height;

/** Where the expanded lane's notes start, under its strip of placed patterns. */
export const notesTop = (box: LaneBox) => box.top + CLIPS;

/** Where the expanded lane's notes stop and its effect strip starts. */
export const stripTop = (box: LaneBox) => box.top + box.height - STRIP;

/** A volume bar's height in the expanded lane's strip, from 0 to 15, over a baseline so that 0 still shows. */
export function volumeHeight(volume: number): number {
  return 2 + (volume / 15) * (STRIP - 9);
}

/** The volume whose bar reaches y in the strip, as drawing volume sets it: the strip's bottom 0, its top 15. */
export function volumeAt(box: LaneBox, y: number): number {
  const base = box.top + box.height - 3; // where the bars stand
  const v = Math.round(((base - y - 2) / (STRIP - 9)) * 15);
  return Math.max(0, Math.min(15, v));
}

export function laneAt(boxes: LaneBox[], y: number): LaneBox | undefined {
  return boxes.find((b) => y >= b.top && y < b.top + b.height);
}

export const rowToX = (v: View, row: number) => GUTTER + (row - v.scrollRow) * v.rowWidth;
export const xToRow = (v: View, x: number) => v.scrollRow + (x - GUTTER) / v.rowWidth;

/** The y of a note's top edge in the expanded lane. */
export const noteToY = (box: LaneBox, pitchTop: number, note: number) => notesTop(box) + (pitchTop - note) * NOTE_HEIGHT;

/** The note whose row in the expanded lane holds y. */
export const yToNote = (box: LaneBox, pitchTop: number, y: number) => Math.ceil(pitchTop - (y - notesTop(box)) / NOTE_HEIGHT);

/** Keeps the expanded lane showing notes from C3 to B8 and no further. */
export function clampPitchTop(box: LaneBox, top: number): number {
  const visible = (box.height - STRIP - CLIPS) / NOTE_HEIGHT;
  return Math.max(Math.min(visible - 1, NOTES - 1), Math.min(NOTES - 1, top));
}

/** Keeps at least half the view on the song. */
export function clampScroll(v: View, width: number, length: number, scrollRow: number): number {
  const visible = (width - GUTTER) / v.rowWidth;
  return Math.max(0, Math.min(Math.max(0, length - visible / 2), scrollRow));
}

/** Zooms the rows by `factor`, keeping the row under `x` where it is. */
export function zoomAt(v: View, x: number, factor: number): Pick<View, 'rowWidth' | 'scrollRow'> {
  const row = xToRow(v, x);
  const rowWidth = Math.max(MIN_ROW_WIDTH, Math.min(MAX_ROW_WIDTH, v.rowWidth * factor));
  return { rowWidth, scrollRow: row - (x - GUTTER) / rowWidth };
}
