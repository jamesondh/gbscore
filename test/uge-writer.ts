import type { UgeCell, UgeInstrument, UgeSong } from '../src/core/uge.ts';

// Writes V6/V7 .uge files, so tests can build songs import should reject, and scripts/song-to-uge.ts can write
// test songs. The inverse of src/core/uge.ts.

export const emptyCell = (): UgeCell => ({ note: 90, instrument: 0, volume: 0, effectCode: 0, effectParams: 0 });

/** An instrument as hUGETracker leaves an unused slot: type 0 duty, 1 wave, 2 noise. */
export function emptyInstrument(type: number, slot: number): UgeInstrument {
  return {
    type,
    name: '',
    length: 0,
    lengthEnabled: false,
    initialVolume: type === 1 ? 0 : 15,
    volSweepDirection: type === 1 ? 0 : 1,
    volSweepAmount: 0,
    sweepTime: 0,
    sweepIncDec: type === 0 ? 1 : 0,
    sweepShift: 0,
    duty: type === 0 ? 2 : 0,
    outputLevel: type === 2 ? 0 : 1,
    waveform: type === 1 ? slot : 0,
    counterStep: 0,
    subpatternEnabled: false,
    subpattern: Array.from({ length: 64 }, emptyCell),
  };
}

class Writer {
  private chunks: number[] = [];
  int32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    this.chunks.push(...b);
  }
  byte(v: number) {
    this.chunks.push(v & 0xff);
  }
  shortString(s: string) {
    this.byte(s.length);
    for (let i = 0; i < 255; i++) this.byte(i < s.length ? s.charCodeAt(i) : 0);
  }
  ansiString(s: string) {
    this.int32(s.length);
    for (const c of s) this.byte(c.charCodeAt(0));
  }
  bytes() {
    return Uint8Array.from(this.chunks);
  }
}

function cells(w: Writer, list: UgeCell[]) {
  for (const c of list) {
    w.int32(c.note);
    w.int32(c.instrument);
    w.int32(c.volume);
    w.int32(c.effectCode);
    w.byte(c.effectParams);
  }
}

function instrument(w: Writer, i: UgeInstrument) {
  w.int32(i.type);
  w.shortString(i.name);
  w.int32(i.length);
  w.byte(i.lengthEnabled ? 1 : 0);
  w.byte(i.initialVolume);
  w.int32(i.volSweepDirection);
  w.byte(i.volSweepAmount);
  w.int32(i.sweepTime);
  w.int32(i.sweepIncDec);
  w.int32(i.sweepShift);
  w.byte(i.duty);
  w.int32(i.outputLevel);
  w.int32(i.waveform);
  w.int32(i.counterStep);
  w.byte(i.subpatternEnabled ? 1 : 0);
  cells(w, i.subpattern);
}

export function writeUge(s: UgeSong): Uint8Array {
  const w = new Writer();
  w.int32(s.version);
  w.shortString(s.name);
  w.shortString(s.artist);
  w.shortString(s.comment);
  for (const bank of [s.duty, s.wave, s.noise]) for (const i of bank) instrument(w, i);
  for (const wave of s.waves) for (const sample of wave) w.byte(sample);
  if (s.version === 6) w.int32(s.ticksPerRow[0]!);
  else for (const t of s.ticksPerRow) w.int32(t);
  w.byte(0);
  w.int32(0);
  w.int32(s.patterns.size);
  for (const [key, p] of s.patterns) {
    w.int32(key);
    cells(w, p);
  }
  for (const list of s.orderMatrix) {
    w.int32(list.length);
    for (const k of list) w.int32(k);
  }
  for (const r of s.routines) w.ansiString(r);
  return w.bytes();
}
