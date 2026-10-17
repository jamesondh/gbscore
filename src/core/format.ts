import { songSchema, type Song } from './schema.ts';

// The canonical form of a song file. `gbscore fmt`, import and the editor all write through formatSong(), so the
// same song always has the same bytes and a diff shows only real changes.

const WIDTH = 120;
const GLOBAL_ORDER = ['tempo', 'pan', 'masterVolume'];

/** Sorts lane items, global items, instruments, waves and patterns; puts keys in schema order; fills defaults and
 * leaves out the ones that mean nothing (no patterns, `repeat: 1`, `transpose: 0`). */
export function normalize(song: Song): Song {
  const s = songSchema.parse(structuredClone(song));
  for (const lane of Object.values(s.lanes)) {
    lane.sort((a, b) => a.row - b.row);
    for (const [i, item] of lane.entries()) {
      if (item.pattern === undefined) continue; // elsewhere they're errors, which compile() reports
      if (item.repeat === 1) delete item.repeat;
      if (item.transpose === 0) delete item.transpose;
      // A placement reads as what it places, then how: row, pattern, transpose, repeat, inst, len.
      const { row, pattern, transpose, repeat, inst, len, ...rest } = item;
      lane[i] = { row, pattern, transpose, repeat, inst, len, ...rest };
    }
  }
  if (s.patterns?.length === 0) delete s.patterns;
  s.patterns?.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // by code units, the same everywhere
  for (const p of s.patterns ?? []) p.items.sort((a, b) => a.row - b.row);
  const kindIndex = (g: object) => GLOBAL_ORDER.findIndex((k) => k in g);
  s.global.sort((a, b) => a.row - b.row || kindIndex(a) - kindIndex(b));
  for (const list of Object.values(s.instruments)) list.sort((a, b) => a.id - b.id);
  s.waves.sort((a, b) => a.id - b.id);
  return s;
}

export function formatSong(song: Song): string {
  return print(normalize(song), '', 0, true) + '\n';
}

function print(value: unknown, indent: string, prefix: number, top = false): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const objects = value.some((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
    if (!objects) {
      const flat = inline(value);
      if (indent.length + prefix + flat.length + 1 <= WIDTH) return flat;
    }
    return `[\n${value.map((v) => inner + print(v, inner, 0)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  if (!top && !hasObjectArray(value)) {
    const flat = inline(value);
    if (indent.length + prefix + flat.length + 1 <= WIDTH) return flat;
  }
  const lines = entries.map(([k, v]) => {
    const key = `${JSON.stringify(k)}: `;
    return inner + key + print(v, inner, key.length);
  });
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

function inline(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(', ')} }`;
}

function hasObjectArray(value: object): boolean {
  return Object.values(value).some(
    (v) =>
      v !== null &&
      typeof v === 'object' &&
      (Array.isArray(v) ? v.some((x) => x !== null && typeof x === 'object' && !Array.isArray(x)) : hasObjectArray(v)),
  );
}
