import type { CompileResult } from './compile.ts';
import { describeEffect } from './effects.ts';
import type { Row } from './driver.ts';
import { position, rowsPerBar } from './location.ts';
import { NO_NOTE, noteName } from './notes.ts';
import { expand, occurrenceEnd, placementExtras } from './patterns.ts';
import { LANES, type LaneItem, type Song } from './schema.ts';

// Short text views of a song for the terminal and for scripts: notes by bar and beat, or the compiled tracker rows.

export interface BarRange {
  from: number; // 1-based, inclusive
  to: number;
}

export function parseBars(text: string): BarRange | string {
  const m = /^(\d+)(?:-(\d+))?$/.exec(text);
  if (!m) return `--bars takes a bar or a range, like 9 or 9-16`;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from < 1 || to < from) return `--bars ${text} is empty`;
  return { from, to };
}

export function summary(song: Song, compiled: CompileResult): string {
  const bar = rowsPerBar(song.grid);
  const bars = Math.ceil(song.length / bar);
  const parts = [
    `${song.title ? `${song.title}: ` : ''}${song.length} rows, ${bars} bar${bars === 1 ? '' : 's'} of ${song.grid.beatsPerBar}×${song.grid.rowsPerBeat}`,
    `loops to ${position(song.grid, song.loop)}`,
    `groove ${song.groove.join(' ')}`,
  ];
  if (compiled.ok) {
    const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
    parts.push(`${compiled.size} bytes, ${n(compiled.data.orders[0]!.length, 'order')}, ${n(compiled.data.patterns.length, 'tracker pattern')}`);
  }
  if (song.patterns?.length) {
    const places = LANES.reduce((sum, lane) => sum + song.lanes[lane].filter((i) => i.pattern !== undefined).length, 0);
    parts.push(`${song.patterns.length} pattern${song.patterns.length === 1 ? '' : 's'} in ${places} place${places === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

function rowRange(song: Song, bars?: BarRange): [number, number] {
  const bar = rowsPerBar(song.grid);
  if (!bars) return [0, song.length];
  return [Math.min(song.length, (bars.from - 1) * bar), Math.min(song.length, bars.to * bar)];
}

/** Notes and effects as they play, one line per lane per bar. Positions are beat.row within the bar. A lane line
 * that a pattern plays in starts with its placement, as [bass-a +5 ×2 from 3.1.1]. */
export function showNotes(song: Song, bars?: BarRange): string {
  const { song: flat, occurrences } = expand(song);
  const [start, end] = rowRange(song, bars);
  const perBar = rowsPerBar(song.grid);
  const out: string[] = [];
  for (let barStart = start - (start % perBar); barStart < end; barStart += perBar) {
    out.push(`bar ${barStart / perBar + 1}`);
    const barEnd = Math.min(barStart + perBar, song.length);
    for (const lane of LANES) {
      const placements = new Set(
        occurrences.filter((o) => o.lane === lane && o.start < barEnd && occurrenceEnd(o) > barStart).map((o) => o.placement),
      );
      const tokens = [...placements].map((p) => {
        return `[${[p.pattern, ...placementExtras(p)].join(' ')} from ${position(song.grid, p.row)}]`;
      });
      tokens.push(...itemTokens(song.grid, flat.lanes[lane], barStart, barEnd));
      if (tokens.length) out.push(`  ${lane.padEnd(7)} ${tokens.join('  ')}`);
    }
    const globals = song.global
      .filter((g) => g.row >= barStart && g.row < barEnd)
      .map((g) => {
        const { row, ...rest } = g;
        const [key, value] = Object.entries(rest)[0]!;
        return `${beatPos(song.grid, row)} ${key} ${Array.isArray(value) ? value.join(',') : String(value)}`;
      });
    if (globals.length) out.push(`  ${'global'.padEnd(7)} ${globals.join('  ')}`);
  }
  return out.join('\n');
}

/** Each pattern: where it's placed, then its notes by its own bars and beats. */
export function showPatterns(song: Song): string {
  const patterns = song.patterns ?? [];
  if (!patterns.length) return 'no patterns';
  const perBar = rowsPerBar(song.grid);
  const out: string[] = [];
  for (const p of patterns) {
    const places = LANES.flatMap((lane) =>
      song.lanes[lane]
        .filter((i) => i.pattern === p.id)
        .map((i) => {
          return [`${lane} ${position(song.grid, i.row)}`, ...placementExtras(i)].join(' ');
        }),
    );
    out.push(`pattern ${p.id}: ${p.kind}, ${p.length} rows, ${places.length ? `placed at ${places.join(', ')}` : 'not placed'}`);
    for (let barStart = 0; barStart < p.length; barStart += perBar) {
      const tokens = itemTokens(song.grid, p.items, barStart, Math.min(barStart + perBar, p.length));
      if (tokens.length) out.push(`  bar ${barStart / perBar + 1}  ${tokens.join('  ')}`);
    }
  }
  return out.join('\n');
}

const beatPos = (grid: Song['grid'], row: number) => position(grid, row).split('.').slice(1).join('.');

/** A lane's notes and effects in a bar, with the note held into it from before. */
function itemTokens(grid: Song['grid'], items: LaneItem[], barStart: number, barEnd: number): string[] {
  const tokens: string[] = [];
  for (const item of items) {
    const itemEnd = item.row + (item.len ?? 1);
    if (item.note !== undefined && item.row < barStart && itemEnd > barStart) {
      tokens.push(`(${item.note} held)`);
    }
    if (item.row < barStart || item.row >= barEnd) continue;
    const parts = [beatPos(grid, item.row)];
    if (item.note !== undefined) {
      parts.push(item.note, item.legato ? 'legato' : `i${item.inst}`, String(item.len));
      if (item.cutTick !== undefined) parts.push(`cutTick ${item.cutTick}`);
    }
    if (item.fx) parts.push(`[${describeEffect(item.fx)}]`);
    tokens.push(parts.join(' '));
  }
  return tokens;
}

function cell(r: Row): string {
  const note = r.note === NO_NOTE ? '---' : noteName(r.note).padEnd(3);
  const inst = r.inst ? String(r.inst).padStart(2, '0') : '..';
  const fx =
    r.code === 0 && r.param === 0 ? '...' : (r.code.toString(16) + r.param.toString(16).padStart(2, '0')).toUpperCase();
  return `${note} ${inst} ${fx}`;
}

/** The compiled tracker rows, one line per row, as the driver plays them. */
export function showRows(song: Song, compiled: CompileResult, bars?: BarRange): string {
  if (!compiled.ok) return 'the song doesn\'t compile; run gbscore check';
  const { data, layout } = compiled;
  const [start, end] = rowRange(song, bars);
  const out = [`row    pos       order:row  ${LANES.map((l) => l.padEnd(10)).join('  ')}`];
  for (let t = start; t < end; t++) {
    let order = layout.orderStarts.length - 1;
    while (layout.orderStarts[order]! > t) order--;
    const row = t - layout.orderStarts[order]!;
    if (row === 0) {
      out.push(`-- order ${order}: patterns ${data.orders.map((o) => o[order]).join(' ')}`);
    }
    const cells = data.orders.map((o) => cell(data.patterns[o[order]!]![row]!));
    out.push(
      `${String(t).padStart(4)}  ${position(song.grid, t).padEnd(9)} ${`${order}:${String(row).padStart(2, '0')}`.padEnd(10)} ${cells.join('  ')}`,
    );
  }
  return out.join('\n');
}
