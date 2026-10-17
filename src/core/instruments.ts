import { decodeEffect, encodeEffect, TABLE_UNSAFE } from './effects.ts';
import { TABLE_ROWS, type Instrument, type Row } from './driver.ts';
import { NO_NOTE } from './notes.ts';
import {
  DUTY_NAMES,
  WAVE_LEVELS,
  type DutyInstrument,
  type InstrumentKind,
  type NoiseInstrument,
  type TableRow,
  type WaveInstrument,
} from './schema.ts';

// Instrument fields to and from the driver's instrument structs. The byte layout matches hUGETracker's
// InstrumentToBytes (instruments.pas) and the way codegen.pas builds each struct's highmask.

export type AnyInstrument = DutyInstrument | WaveInstrument | NoiseInstrument;

export function encodeInstrument(kind: InstrumentKind, inst: AnyInstrument): Instrument | string {
  const table = inst.table ? encodeTable(kind, inst.table) : null;
  if (typeof table === 'string') return table;
  const envelope = (i: DutyInstrument | NoiseInstrument) =>
    (i.volume << 4) | (i.envDir === 'up' ? 0x08 : 0) | i.envPace;
  const lengthBit = inst.lengthEnabled ? 0x40 : 0;
  switch (kind) {
    case 'duty': {
      const i = inst as DutyInstrument;
      const sweep = (i.sweepTime << 4) | (i.sweepDir === 'down' ? 0x08 : 0) | i.sweepShift;
      const lenDuty = (DUTY_NAMES.indexOf(i.duty) << 6) | i.length;
      return { fields: [sweep, lenDuty, envelope(i), 0x80 | lengthBit], table };
    }
    case 'wave': {
      const i = inst as WaveInstrument;
      return { fields: [i.length, WAVE_LEVELS.indexOf(i.level) << 5, i.wave, 0x80 | lengthBit], table };
    }
    case 'noise': {
      const i = inst as NoiseInstrument;
      return { fields: [envelope(i), i.length | lengthBit | (i.bits === 7 ? 0x80 : 0), 0, 0], table };
    }
  }
}

/** Placeholder for instrument numbers below the highest one used that the song doesn't define. */
export const SILENT_INSTRUMENT: Instrument = { fields: [0, 0, 0, 0], table: null };

function encodeTable(kind: InstrumentKind, rows: TableRow[]): Row[] | string {
  const out: Row[] = [];
  for (let i = 0; i < TABLE_ROWS; i++) {
    const r = rows[i] ?? {};
    let code = 0;
    let param = 0;
    if (r.fx) {
      const fx = encodeEffect(r.fx, kind, true);
      if (typeof fx === 'string') return `table row ${i}: ${fx}`;
      ({ code, param } = fx);
    }
    // The last row jumps back to row 0 unless it says otherwise (codegen.pas RenderGBDKSubpatternCell).
    const jump = r.jump !== undefined ? r.jump + 1 : i === TABLE_ROWS - 1 ? 1 : 0;
    out.push({ note: r.note !== undefined ? r.note + 36 : NO_NOTE, inst: jump, code, param });
  }
  return out;
}

/** Reads a table back from driver rows. Returns an error message for rows the song format can't hold. */
export function decodeTable(kind: InstrumentKind, rows: Row[]): TableRow[] | undefined | string {
  const out: TableRow[] = [];
  for (let i = 0; i < TABLE_ROWS; i++) {
    const r = rows[i]!;
    const row: TableRow = {};
    if (r.note !== NO_NOTE) {
      if (r.note > 71) return `table row ${i} has note value ${r.note}`;
      row.note = r.note - 36;
    }
    if (r.inst !== 0 && !(i === TABLE_ROWS - 1 && r.inst === 1)) {
      if (r.inst > 31) return `table row ${i} jumps to ${r.inst}, past the table`;
      row.jump = r.inst - 1;
    }
    if (r.code !== 0 || r.param !== 0) {
      if ([0x5, 0x6, 0x8, 0xb, 0xd, 0xf].includes(r.code)) {
        return `table row ${i} uses effect ${r.code.toString(16).toUpperCase()}xx, which tables don't support`;
      }
      if (TABLE_UNSAFE[r.code]) return `table row ${i}: ${TABLE_UNSAFE[r.code]}`;
      const fx = decodeEffect(r.code, r.param, kind);
      if (fx) row.fx = fx;
    }
    out.push(row);
  }
  while (out.length && Object.keys(out[out.length - 1]!).length === 0) out.pop();
  return out.length ? out : undefined;
}
