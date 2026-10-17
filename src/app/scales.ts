import { expand } from '../core/patterns.ts';
import { LANE_KIND, LANES, type Song } from '../core/schema.ts';
import { noteIndex } from './song.ts';

// Scales the roll can shade, as FL Studio's scale highlighting does. A view setting: the song doesn't keep it.

export const SCALES = {
  major: { name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor: { name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  dorian: { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  mixolydian: { name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  majorPentatonic: { name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  minorPentatonic: { name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
} as const;

export type ScaleKind = keyof typeof SCALES;

export interface Scale {
  root: number; // 0 is C
  kind: ScaleKind;
}

export const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const inScale = (scale: Scale, note: number) =>
  (SCALES[scale.kind].steps as readonly number[]).includes((((note - scale.root) % 12) + 12) % 12);

export const scaleName = (scale: Scale) => `${ROOTS[scale.root]} ${SCALES[scale.kind].name.toLowerCase()}`;

/** The root that puts the most of the song's pitched notes, by rows held, in a kind of scale. Of roots that tie,
 * as a few notes fit several keys, the one held longest wins, then the lowest. */
export function bestRoot(song: Song, kind: ScaleKind): number {
  const held = new Array<number>(12).fill(0);
  for (const lane of LANES) {
    if (LANE_KIND[lane] === 'noise') continue;
    for (const item of expand(song).song.lanes[lane]) if (item.note) held[noteIndex(item.note) % 12]! += item.len ?? 1;
  }
  let best = 0;
  let most = -1;
  for (let root = 0; root < 12; root++) {
    const fit = held.reduce((sum, rows, pc) => sum + (inScale({ root, kind }, pc) ? rows : 0), 0);
    if (fit > most || (fit === most && held[root]! > held[best]!)) [best, most] = [root, fit];
  }
  return best;
}
