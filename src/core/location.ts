// Song positions in DAW style, bar.beat.row, all counting from 1. With 4 rows per beat a row is a sixteenth, so
// 3.2.2 means the same as it does in Ableton. The grid is display only, so positions never change the sound.

export interface Grid {
  rowsPerBeat: number;
  beatsPerBar: number;
}

export function rowsPerBar(grid: Grid): number {
  return grid.rowsPerBeat * grid.beatsPerBar;
}

export function position(grid: Grid, row: number): string {
  const bar = Math.floor(row / rowsPerBar(grid)) + 1;
  const inBar = row % rowsPerBar(grid);
  const beat = Math.floor(inBar / grid.rowsPerBeat) + 1;
  const sub = (inBar % grid.rowsPerBeat) + 1;
  return `${bar}.${beat}.${sub}`;
}

export interface SongError {
  message: string;
  lane?: string; // a lane name, or "global"
  row?: number;
  path?: string; // where in the file, when there's no row
  pattern?: string; // the pattern the item is in, if it's in one
  patternRow?: number; // and its row in the pattern
}

export function formatError(grid: Grid | undefined, e: SongError): string {
  const at: string[] = [];
  if (e.row !== undefined) {
    at.push(grid ? `${position(grid, e.row)} (row ${e.row})` : `row ${e.row}`);
  }
  if (e.lane) at.push(e.lane);
  if (e.pattern !== undefined) {
    at.push(`pattern ${e.pattern}` + (e.patternRow === undefined ? '' : ` at ${inPattern(grid, e.patternRow)}`));
  }
  if (e.path && e.row === undefined && e.pattern === undefined) at.push(e.path);
  return at.length ? `${at.join(', ')}: ${e.message}` : e.message;
}

/** A row in a pattern, by its own bars and beats. */
function inPattern(grid: Grid | undefined, row: number): string {
  return grid ? `${position(grid, row)} (its row ${row})` : `its row ${row}`;
}

/** Errors as text, one line each, except that an error at the same row of a pattern in several places is one line
 * that says how many. */
export function formatErrors(grid: Grid | undefined, errors: SongError[]): string[] {
  const lines = new Map<string, { e: SongError; count: number }>();
  for (const [i, e] of errors.entries()) {
    // Messages can name timeline positions, which differ from place to place; the pattern row doesn't.
    const message = e.message.replace(/\b\d+\.\d+\.\d+\b/g, '');
    const key = e.pattern !== undefined && e.patternRow !== undefined ? `${e.pattern}\0${e.patternRow}\0${message}` : String(i);
    const seen = lines.get(key);
    if (seen) seen.count++;
    else lines.set(key, { e, count: 1 });
  }
  return [...lines.values()].map(({ e, count }) => formatError(grid, e) + (count > 1 ? ` (in ${count} places; this is the first)` : ''));
}
